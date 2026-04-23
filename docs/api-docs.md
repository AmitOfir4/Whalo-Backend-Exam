# API Documentation

## Overview

The Whalo Mobile Game Backend is 4 HTTP microservices + 2 background workers talking over RabbitMQ.

| Service | Base URL | Description |
|---------|----------|-------------|
| Player Management | `http://localhost:3001` | CRUD player profiles; publishes `player_events` on every mutation |
| Game Score | `http://localhost:3002` | Score submission + top-10; also **consumes** `player_events` to keep denormalized state in sync |
| Leaderboard | `http://localhost:3003` | Redis-powered paginated leaderboard with cold-start backfill guarded by a distributed lock |
| Log Management | `http://localhost:3004` | Async log ingestion via RabbitMQ priority queue |
| Score Worker | — | Consumes `score_events` → batch-writes `scores`, `$inc` `playerscores`, updates Redis ranking sets |
| Log Worker | — | Consumes `logs_queue` → batch `insertMany` into MongoDB (priority-aware flushing) |

Write-heavy endpoints (`POST /scores`, `POST /logs`) return **`202 Accepted`** immediately and persist asynchronously via RabbitMQ → a batch worker. Retries are idempotent at every layer — unique Mongo indexes absorb duplicates, `$inc` and Redis writes are scoped to genuinely new inserts, and top-10 Lua scripts are idempotent for the same member.

---

## 1. Player Management Service

### POST /players
Create a new player profile.

**Request Body:**
```json
{
  "username": "PlayerOne",
  "email": "player1@example.com"
}
```

**Validation Rules:**
- `username`: string, required, 3–30 characters, no spaces allowed, stored lowercase
- `email`: string, required, valid email format, stored lowercase

**Responses:**

| Status | Description |
|--------|-------------|
| 201 | Player created successfully |
| 400 | Validation failed (missing/invalid fields) |
| 409 | Email or username already exists |

**Example Response (201):**
```json
{
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "username": "PlayerOne",
  "email": "player1@example.com",
  "createdAt": "2026-04-19T10:00:00.000Z",
  "updatedAt": "2026-04-19T10:00:00.000Z"
}
```

---

> `GET /players` with no `:playerId` is deliberately not exposed. No product surface needs a full player dump, and omitting it keeps the service cheaper to operate.

---

### GET /players/:playerId
Retrieve a player profile by their UUID.

**Responses:**

| Status | Description |
|--------|-------------|
| 200 | Player found |
| 404 | Player not found |

---

### PUT /players/:playerId
Update a player's username and/or email.

**Request Body:**
```json
{
  "username": "NewName"
}
```

**Validation Rules:**
- At least one of `username` or `email` must be provided
- Same validation rules as creation (`username` no spaces, stored lowercase)

**Responses:**

| Status | Description |
|--------|-------------|
| 200 | Player updated |
| 400 | Validation failed |
| 404 | Player not found |
| 409 | Email or username already exists |

---

### DELETE /players/:playerId
Delete a player profile. Returns no response body on success.

**Responses:**

| Status | Description |
|--------|-------------|
| 204 | Player deleted (no body) |
| 404 | Player not found |

---

## 2. Game Score Service

### POST /scores
Submit a game score for a player. Responds **`202 Accepted`** — durable persistence is async.

After validating the request and confirming the player exists via a single `SISMEMBER players:known` (with a one-time MongoDB-backed cold-start hydration of the set, guarded by a distributed lock), the service:

1. Publishes a `score.submitted` event to the `score_events` RabbitMQ queue.
2. Updates **both Redis read paths synchronously, in parallel**, using two idempotent Lua scripts:
   - Top-10 sorted set + hash (`top10scores:set` / `top10scores:data`).
   - Leaderboard `ZINCRBY`, gated by `SET applied:leaderboard:<scoreKey> NX EX <ttl>` so repeated invocations for the same `scoreKey = playerId:timestamp` are no-ops.

The client therefore sees its submission reflected in `GET /scores/top` and `GET /players/leaderboard` immediately, even when the Score Worker's queue is deeply backlogged.

The Score Worker still re-runs the same two scripts when it processes the message, so the Redis writes survive a service crash between publish and Redis update. Durable persistence (`insertMany` into `scores` + `$inc` on `playerscores`) remains the worker's responsibility.

**Request Body:**
```json
{
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "score": 1500
}
```

**Validation Rules:**
- `playerId`: string, required, non-empty
- `score`: integer, required, >= 0

**Responses:**

| Status | Description |
|--------|-------------|
| 202 | Score accepted — top scores updated immediately, full persistence async |
| 400 | Validation failed |
| 404 | Player not found |

**Example Response (202):**
```json
{
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "score": 1500
}
```

> Display names are not returned here — clients resolve them via `GET /players/:playerId` against `player-service` when needed.

---

### GET /scores/top
Retrieve the top 10 highest individual scores. Results are served directly from a **Redis Sorted Set** (`top10scores:set`) + Hash (`top10scores:data`) — no MongoDB query, no TTL expiry. On cold start (empty sorted set) the service hydrates from MongoDB automatically.

**Response (200):**
```json
[
  {
    "playerId": "abc-123",
    "score": 5000,
    "createdAt": "2026-04-19T10:00:00.000Z"
  }
]
```

> The response carries `playerId` only. Clients render display names by calling `GET /players/:playerId` per row against `player-service`.

---

## 3. Leaderboard Service

### GET /players/leaderboard
Retrieve players sorted by their total aggregated score. Rankings are served from a **Redis Sorted Set** (`ZREVRANGE`) for O(log N) reads. On cold start the sorted set is populated from the `playerscores` MongoDB collection.

**Query Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| page | number | 1 | Page number (1-indexed) |
| limit | number | 10 | Results per page (max 100) |

**Response (200):**
```json
{
  "data": [
    {
      "playerId": "abc-123",
      "totalScore": 8500
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "totalPlayers": 50,
    "totalPages": 5,
    "hasNextPage": true,
    "hasPreviousPage": false
  }
}
```

> As with `/scores/top`, only `playerId` and the numeric score are returned. Leaderboard-service deliberately does not read the `players` collection — the client resolves display names via `GET /players/:playerId` on `player-service` per row from this response (if enrichment is needed).

---

## 4. Log Management Service

### POST /logs
Submit client log data. The endpoint responds immediately with `202 Accepted` — actual log processing happens asynchronously via RabbitMQ and the log worker. Messages are routed through a **priority queue** (`x-max-priority: 3`); `high` priority messages are consumed before `normal` and `low` within each consumer's prefetch window. The log worker is also **priority-aware on the flush side**: when any buffered message is `high` priority, the flush threshold shrinks 5× and the flush timer 4× so high-priority logs reach MongoDB without waiting for the normal 50-message / 2-second window.

**Request Body:**
```json
{
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "logData": "Player completed level 5 with score 1500",
  "priority": "normal"
}
```

**Validation Rules:**
- `playerId`: string, required, non-empty
- `logData`: string, required, non-empty
- `priority`: optional enum — `"low"`, `"normal"`, `"high"` (default: `"normal"`)

**Responses:**

| Status | Description |
|--------|-------------|
| 202 | Log received and queued for async processing |
| 400 | Validation failed |

---

## Health Checks

Every service exposes a `GET /health` endpoint:

```json
{
  "status": "ok",
  "service": "player-service"
}
```

---

## Error Format

All errors follow a consistent format:

```json
{
  "error": {
    "message": "Descriptive error message",
    "code": 400,
    "details": [
      { "field": "email", "message": "Invalid email format" }
    ]
  }
}
```

The `details` array is included only for validation errors (400).
