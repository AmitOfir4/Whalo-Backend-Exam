# API Documentation

## Overview

The Whalo Mobile Game Backend consists of 4 API microservices and 2 background workers:

| Service | Base URL | Description |
|---------|----------|-------------|
| Player Management | `http://localhost:3001` | CRUD operations for player profiles |
| Game Score | `http://localhost:3002` | Score submission and top scores |
| Leaderboard | `http://localhost:3003` | Redis-powered leaderboard with pagination |
| Log Management | `http://localhost:3004` | Async log ingestion via RabbitMQ priority queue |
| Score Worker | — | Processes `score_events` queue → updates `playerscores` + Redis |
| Log Worker | — | Processes `logs_queue` → batch-writes to MongoDB |

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

### GET /players
Retrieve all player profiles.

**Responses:**

| Status | Description |
|--------|-------------|
| 200 | Array of player objects |

**Example Response (200):**
```json
[
  {
    "playerId": "550e8400-e29b-41d4-a716-446655440000",
    "username": "playerone",
    "email": "player1@example.com",
    "createdAt": "2026-04-19T10:00:00.000Z",
    "updatedAt": "2026-04-19T10:00:00.000Z"
  }
]
```

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
Delete a player profile.

**Responses:**

| Status | Description |
|--------|-------------|
| 200 | Player deleted |
| 404 | Player not found |

---

## 2. Game Score Service

### POST /scores
Submit a game score for a player. The service immediately updates the top-scores Redis sorted set via an atomic Lua script for instant visibility, then publishes a `score.submitted` event to RabbitMQ. Score persistence to MongoDB and leaderboard aggregation are handled asynchronously by the Score Worker. Responds **202 Accepted**.

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
  "username": "playerone",
  "score": 1500
}
```

---

### GET /scores/top
Retrieve the top 10 highest individual scores. Results are served directly from a **Redis Sorted Set** (`top10scores:set`) + Hash (`top10scores:data`) — no MongoDB query, no TTL expiry. On cold start (empty sorted set) the service hydrates from MongoDB automatically.

**Response (200):**
```json
[
  {
    "playerId": "abc-123",
    "username": "PlayerOne",
    "score": 5000,
    "createdAt": "2026-04-19T10:00:00.000Z"
  }
]
```

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
      "username": "playerone",
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

---

## 4. Log Management Service

### POST /logs
Submit client log data. The endpoint responds immediately with 202 Accepted — actual log processing happens asynchronously via RabbitMQ and the log worker. Messages are routed through a **priority queue** (capacity 3); `high` priority messages are processed before `normal` and `low`.

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
