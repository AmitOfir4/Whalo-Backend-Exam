# API Documentation

## Overview

The Whalo Mobile Game Backend consists of 4 independent microservices:

| Service | Base URL | Description |
|---------|----------|-------------|
| Player Management | `http://localhost:3001` | CRUD operations for player profiles |
| Game Score | `http://localhost:3002` | Score submission and top scores |
| Leaderboard | `http://localhost:3003` | Aggregated leaderboard with pagination |
| Log Management | `http://localhost:3004` | Async log ingestion via RabbitMQ |

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
- `username`: string, required, 3–30 characters
- `email`: string, required, valid email format

**Responses:**

| Status | Description |
|--------|-------------|
| 201 | Player created successfully |
| 400 | Validation failed (missing/invalid fields) |
| 409 | Email already exists |

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
- Same validation rules as creation

**Responses:**

| Status | Description |
|--------|-------------|
| 200 | Player updated |
| 400 | Validation failed |
| 404 | Player not found |
| 409 | Email already exists |

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
Submit a game score for a player.

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
| 201 | Score submitted |
| 400 | Validation failed |
| 404 | Player not found |

---

### GET /scores/top
Retrieve the top 10 highest individual scores.

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
Retrieve players sorted by their total aggregated score across all submissions.

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
      "username": "PlayerOne",
      "totalScore": 8500,
      "gamesPlayed": 5
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
Submit client log data. The endpoint responds immediately with 202 Accepted — actual log processing happens asynchronously via RabbitMQ and the log worker.

**Request Body:**
```json
{
  "playerId": "550e8400-e29b-41d4-a716-446655440000",
  "logData": "Player completed level 5 with score 1500"
}
```

**Validation Rules:**
- `playerId`: string, required, non-empty
- `logData`: string, required, non-empty

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
