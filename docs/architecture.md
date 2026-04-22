# Architecture

This document covers the runtime topology, the three async data flows (score, player events, log), the retry-safety model, and the Redis / MongoDB layout. The design principles driving it are:

- **Async, bounded write paths** — `/scores` and `/logs` return `202` immediately and persist via a RabbitMQ → batch-worker pipeline, so HTTP latency is decoupled from DB write throughput.
- **Redis is the source of truth for rankings** — the leaderboard sorted set and the top-10 set + hash are never TTL'd; MongoDB is the durable backup, not the read path.
- **Idempotent by construction** — every redelivery-safe step is enforced by a Mongo unique index, a scoped `$inc`, or an idempotent Lua script.
- **Eventually consistent fan-out** — `player.*` events propagate over RabbitMQ so score-service can update its denormalized state (`playerscores` aggregates, `players:known` existence set) without being on the player-service's HTTP critical path.
- **No cross-service denormalization of display names** — scores and playerscores store `playerId` only. Clients resolve usernames for leaderboard / top-score rows via `GET /players/:playerId` against `player-service` when enrichment is needed.

## System Overview

```mermaid
graph TB
    Client[Mobile Game Client]

    subgraph API["Microservices (Express.js / TypeScript)"]
        PS[Player Service<br/>:3001]
        SS[Score Service<br/>:3002]
        LS[Leaderboard Service<br/>:3003]
        LGS[Log Service<br/>:3004]
    end

    subgraph Queue["Message Broker"]
        RMQ[RabbitMQ<br/>:5672]
    end

    subgraph Workers["Background Workers"]
        LW[Log Worker]
        SW[Score Worker]
    end

    subgraph Storage["Data Layer"]
        MongoDB[(MongoDB Atlas)]
        Redis[(Redis<br/>:6379)]
    end

    Client -->|CRUD /players| PS
    Client -->|POST /scores<br/>GET /scores/top| SS
    Client -->|GET /players/leaderboard| LS
    Client -->|POST /logs| LGS

    PS -->|Read/Write players| MongoDB
    PS -->|Publish player_events| RMQ
    SS -->|Read (cold-start hydration of players:known + top-10)| MongoDB
    SS -->|SISMEMBER players:known| Redis
    SS -->|Publish score_events| RMQ
    SS -->|Consume player_events| RMQ
    LS -->|ZREVRANGE leaderboard| Redis
    LGS -->|Publish logs_queue| RMQ

    RMQ -->|Consume logs_queue| LW
    RMQ -->|Consume score_events| SW
    LW -->|Batch insertMany()| MongoDB
    SW -->|Update playerscores| MongoDB
    SW -->|Idempotent Lua<br/>leaderboard + top-10| Redis
    SS -.->|Idempotent Lua<br/>leaderboard + top-10<br/>(sync visibility)| Redis
```

---

## Score Pipeline — Async Data Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant SS as Score Service
    participant Redis as Redis
    participant RMQ as RabbitMQ
    participant SW as Score Worker (Batcher)
    participant DB as MongoDB

    C->>SS: POST /scores {playerId, score}
    SS->>SS: Validate with Zod
    SS->>Redis: SISMEMBER players:known playerId
    alt players:known empty (cold start)
        SS->>DB: projection read of playerscores → SADD players:known
        SS->>Redis: Retry SISMEMBER
    end
    SS->>SS: Generate timestamp → scoreKey = playerId:timestamp
    SS->>RMQ: Publish score.submitted {playerId, score, timestamp}
    par Immediate Redis visibility (parallel)
        SS->>Redis: Lua ZADD top10scores:set + HSET top10scores:data
    and
        SS->>Redis: Lua SET NX applied:leaderboard:<scoreKey> → ZINCRBY leaderboard
    end
    SS-->>C: 202 Accepted {playerId, score}

    Note over RMQ,SW: Asynchronous batch processing

    RMQ->>SW: Buffer score.submitted messages
    SW->>SW: Flush when batch full OR timer fires
    SW->>DB: insertMany(scores) ordered:false — absorb duplicate-key (11000) errors, identify new inserts
    alt newBatch has genuinely new inserts
        SW->>DB: bulkWrite(playerscores $inc totalScore/gamesPlayed) — new inserts only
        SW->>Redis: Pipeline — same top-10 + idempotent-leaderboard Lua scripts (no-ops if service already applied)
    end
    SW->>RMQ: ACK all messages in batch
```

**Sync-visibility path.** Both Redis read paths are updated on the HTTP request so the client sees its submission reflected in `/scores/top` and `/players/leaderboard` before the worker ever touches the `score_events` queue. Without this, any queue backlog (e.g., under k6 load) would delay visible leaderboard totals by the full FIFO depth — users would submit a score and watch it apparently vanish until the worker caught up.

**Retry idempotency** is enforced at four independent layers, so the service's sync writes *and* the worker's async retry writes can execute against the same message without corruption:

- **MongoDB scores** — a unique compound index on `{ playerId, createdAt }` causes `insertMany({ordered:false})` to absorb duplicate-key (11000) errors silently on retry. The response identifies which documents were *genuinely new* inserts vs. already-persisted duplicates.
- **MongoDB playerscores** — `$inc` (`totalScore`, `gamesPlayed`) only runs for the genuinely new inserts identified above — preventing double-counting on redelivery.
- **Top-10 Redis set** — the Lua script uses the same `scoreKey = playerId:timestamp` in both paths; `ZADD` / `HSET` for an identical member+score pair is a no-op.
- **Leaderboard ZINCRBY** — `ZINCRBY` is not naturally idempotent, so the script gates it behind `SET applied:leaderboard:<scoreKey> NX EX <ttl>`. The first caller (whichever path runs first) creates the marker and applies the increment; the second caller sees the marker already exists and skips. The marker self-expires after `LEADERBOARD_APPLIED_TTL_SECONDS` (24h default), which must exceed the worst-case worker lag.

---

## Player Events — Async Data Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant PS as Player Service
    participant RMQ as RabbitMQ
    participant SS as Score Service (consumer)
    participant Redis as Redis
    participant DB as MongoDB

    C->>PS: POST /players {username, email}
    PS->>DB: Player.create(...)
    PS->>RMQ: Publish player.created → player_events
    PS-->>C: 201 Created

    RMQ->>SS: Deliver player.created
    SS->>DB: upsert playerscores {playerId, totalScore:0, gamesPlayed:0}
    SS->>Redis: SADD players:known playerId

    Note over PS,SS: player.deleted triggers tombstone-cascade; player.username_updated is a no-op here
```

On `player.deleted` the consumer removes `playerscores`, all `scores`, `ZREM leaderboard`, `SREM players:known`, and runs an atomic Lua script that scans the (≤10 entry) `top10scores:set` sorted set and removes every `playerId:*` member from both the set and the `top10scores:data` hash in a single round-trip — ensuring the deleted player's individual score entries disappear from the top-scores read path immediately.

`player.username_updated` is a registered no-op handler on the score-service consumer: the score pipeline never stores the username, so renames require no cascade. Clients always re-resolve display names against `player-service` via `GET /players/:playerId`, so the update is visible on the next read.

---

## Log Pipeline — Async Data Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant LS as Log Service
    participant RMQ as RabbitMQ
    participant LW as Log Worker
    participant DB as MongoDB

    C->>LS: POST /logs {playerId, logData, priority?}
    LS->>LS: Validate with Zod
    LS->>RMQ: Publish to logs_queue (priority queue, x-max-priority=3)
    LS-->>C: 202 Accepted

    Note over RMQ,LW: Asynchronous processing

    RMQ->>LW: Deliver message
    LW->>LW: Buffer message
    
    alt Buffer full (≥50) OR Timer (≥2s)
        LW->>LW: Acquire Semaphore slot (max 3 concurrent)
        LW->>LW: Acquire Token Bucket token
        LW->>DB: insertMany(batch)
        DB-->>LW: Write confirmed
        LW->>RMQ: ACK all messages in batch
        LW->>LW: Release Semaphore slot
    end
```

---

## Score Worker Rate Control Strategies

```mermaid
graph LR
    subgraph Input
        MSG[Incoming Messages<br/>from RabbitMQ<br/>score_events queue]
    end

    subgraph Batcher["Batcher"]
        BUF[Message Buffer]
        TIMER[Flush Timer<br/>2 seconds]
        SIZE[Size Threshold<br/>50 messages]
    end

    subgraph RateControl["Rate Control"]
        SEM[Semaphore<br/>Max 3 concurrent writes]
        TB[Token Bucket<br/>Capacity: 10<br/>Refill: 5/sec]
    end

    subgraph Output
        DB1[(MongoDB scores<br/>insertMany)]
        DB2[(MongoDB playerscores<br/>bulkWrite $inc)]
        R1[(Redis<br/>Lua top-10<br/>+ Lua idempotent<br/>leaderboard ZINCRBY)]
    end

    MSG --> BUF
    BUF --> SIZE
    BUF --> TIMER
    SIZE -->|Flush| SEM
    TIMER -->|Flush| SEM
    SEM --> TB
    TB --> DB1
    TB --> DB2
    TB --> R1
```

---

## Log Worker Rate Control Strategies

```mermaid
graph LR
    subgraph Input
        MSG[Incoming Messages<br/>from RabbitMQ]
    end

    subgraph Batcher["Batcher (priority-aware)"]
        BUF[Message Buffer]
        TIMER[Flush Timer<br/>2s normal / 500ms if high-priority present]
        SIZE[Size Threshold<br/>50 normal / 10 if high-priority present]
    end

    subgraph RateControl["Rate Control"]
        SEM[Semaphore<br/>Max 3 concurrent writes]
        TB[Token Bucket<br/>Capacity: 10<br/>Refill: 5/sec]
    end

    subgraph Output
        DB[(MongoDB<br/>insertMany)]
    end

    MSG --> BUF
    BUF --> SIZE
    BUF --> TIMER
    SIZE -->|Flush| SEM
    TIMER -->|Flush| SEM
    SEM --> TB
    TB --> DB
```

**Priority-aware flushing:** the log worker's batcher tracks whether any buffered message is `high` priority. When it is, the flush threshold shrinks by 5× (50 → 10) and the flush timer by 4× (2000 ms → 500 ms), so high-priority logs clear to MongoDB well ahead of the normal flush window.

---

## Top Scores Read Path — Redis Sorted Set

```mermaid
graph LR
    C[Client<br/>GET /scores/top]
    subgraph ScoreService["Score Service"]
        CW[Cold Start Check<br/>ZCARD top10scores:set]
        HY[Hydrate from MongoDB<br/>top 10 scores]
        ZR[ZREVRANGE top10scores:set<br/>0 9]
        HM[HMGET top10scores:data<br/>...scoreKeys]
    end
    Redis[(Redis)]
    DB[(MongoDB scores)]
    RES[Response]

    C --> CW
    CW -->|size == 0| HY
    HY --> DB
    HY --> Redis
    CW -->|size > 0| ZR
    ZR --> Redis
    ZR --> HM
    HM --> Redis
    HM --> RES
```

The top-scores sorted set is always up to date — no TTL expiry. It is updated atomically via a Lua script from two places:
- **Score Service** (HTTP path) — immediately on score submission for instant visibility
- **Score Worker** (async path) — idempotently on batch flush; same `scoreKey = playerId:timestamp` prevents duplicates

---

## Leaderboard Read Path — Redis Sorted Set

```mermaid
graph LR
    C[Client<br/>GET /players/leaderboard]
    subgraph LeaderboardService["Leaderboard Service"]
        CW[Cold Start Check<br/>ZCARD leaderboard]
        BF[Backfill from<br/>playerscores collection]
        ZR[ZREVRANGE leaderboard<br/>start stop WITHSCORES]
    end
    Redis[(Redis)]
    DB[(MongoDB<br/>playerscores)]
    RES[Paginated Response<br/>playerId + totalScore only]

    C --> CW
    CW -->|size == 0| BF
    BF --> DB
    BF --> Redis
    CW -->|size > 0| ZR
    ZR --> Redis
    ZR --> RES
```

Display names are resolved by the client via `GET /players/:playerId` against `player-service` per row after consuming the leaderboard response — keeping this service on a single data store (Redis) and off the `players` collection entirely.

On cold start (empty sorted set after Redis restart), the leaderboard service re-populates from the `playerscores` MongoDB collection. A **distributed Redis lock** (`SET NX PX 30000`) ensures only one service instance runs the expensive backfill — concurrent instances detect the lock is held, wait 300 ms, and return; the next request hits the already-populated fast path.

---

## Database Schema

```mermaid
erDiagram
    PLAYERS {
        string playerId PK "UUID v4"
        string username UK "lowercase, no spaces"
        string email UK "lowercase"
        datetime createdAt
        datetime updatedAt
    }

    SCORES {
        ObjectId _id PK
        string playerId FK "unique with createdAt"
        number score
        datetime createdAt "unique with playerId"
    }

    PLAYERSCORES {
        ObjectId _id PK
        string playerId UK "FK"
        number totalScore "sum of all scores"
        number gamesPlayed "count of submissions"
    }

    LOGS {
        ObjectId _id PK
        string playerId FK
        string logData
        string priority "low | normal | high"
        datetime receivedAt
        datetime processedAt
    }

    PLAYERS ||--o{ SCORES : "submits"
    PLAYERS ||--|| PLAYERSCORES : "aggregated in"
    PLAYERS ||--o{ LOGS : "generates"
```

---

## Docker Compose Architecture

```mermaid
graph TB
    subgraph DockerNetwork["whalo-network (bridge)"]
        REDIS[redis:7-alpine<br/>:6379]
        RMQ[rabbitmq:3-management<br/>:5672 / :15672]
        PS[player-service<br/>:3001]
        SS[score-service<br/>:3002]
        LS[leaderboard-service<br/>:3003]
        LGS[log-service<br/>:3004]
        LW[log-worker<br/>SIGTERM/SIGINT graceful]
        SW[score-worker<br/>SIGTERM/SIGINT graceful]
    end

    ATLAS[(MongoDB Atlas<br/>external)]

    PS --> ATLAS
    PS --> RMQ
    SS --> ATLAS
    SS --> REDIS
    SS --> RMQ
    LS --> REDIS
    LGS --> RMQ
    LW --> ATLAS
    LW --> RMQ
    SW --> ATLAS
    SW --> REDIS
    SW --> RMQ
```
