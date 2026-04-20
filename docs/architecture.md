# Architecture

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
    SS -->|Read/Write scores| MongoDB
    SS -->|Username lookup| Redis
    SS -->|Publish score_events| RMQ
    SS -->|Consume player_events| RMQ
    LS -->|ZREVRANGE leaderboard| Redis
    LGS -->|Publish logs_queue| RMQ

    RMQ -->|Consume logs_queue| LW
    RMQ -->|Consume score_events| SW
    LW -->|Batch insertMany()| MongoDB
    SW -->|Update playerscores| MongoDB
    SW -->|ZINCRBY leaderboard| Redis
```

---

## Score Pipeline — Async Data Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant SS as Score Service
    participant Redis as Redis
    participant RMQ as RabbitMQ
    participant SW as Score Worker
    participant DB as MongoDB

    C->>SS: POST /scores {playerId, score}
    SS->>SS: Validate with Zod
    SS->>Redis: HGET leaderboard:usernames playerId
    alt Username not cached
        SS->>DB: findOne players {playerId}
        SS->>Redis: HSET leaderboard:usernames playerId username
    end
    SS->>DB: Score.create({playerId, username, score})
    SS->>RMQ: Publish score.submitted → score_events
    SS-->>C: 202 Accepted

    Note over RMQ,SW: Asynchronous processing

    RMQ->>SW: Deliver score.submitted
    SW->>DB: updateOne playerscores {$inc: totalScore, gamesPlayed}
    SW->>Redis: ZINCRBY leaderboard score playerId
    SW->>Redis: DEL top10scores
    SW->>RMQ: ACK message
```

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
    SS->>DB: upsert playerscores {playerId, username, totalScore:0}
    SS->>Redis: HSET leaderboard:usernames playerId username

    Note over PS,SS: Same flow for player.username_updated and player.deleted
```

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

## Log Worker Rate Control Strategies

```mermaid
graph LR
    subgraph Input
        MSG[Incoming Messages<br/>from RabbitMQ]
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

---

## Leaderboard Read Path — Redis Sorted Set

```mermaid
graph LR
    C[Client<br/>GET /players/leaderboard]
    subgraph LeaderboardService["Leaderboard Service"]
        CW[Cold Start Check<br/>ZCARD leaderboard]
        BF[Backfill from<br/>playerscores collection]
        ZR[ZREVRANGE leaderboard<br/>start stop WITHSCORES]
        HM[HMGET leaderboard:usernames<br/>...playerIds]
    end
    Redis[(Redis)]
    DB[(MongoDB<br/>playerscores)]
    RES[Paginated Response]

    C --> CW
    CW -->|size == 0| BF
    BF --> DB
    BF --> Redis
    CW -->|size > 0| ZR
    ZR --> Redis
    ZR --> HM
    HM --> Redis
    HM --> RES
```

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
        string playerId FK
        string username "denormalized"
        number score
        datetime createdAt
    }

    PLAYERSCORES {
        ObjectId _id PK
        string playerId UK "FK"
        string username "denormalized"
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
        LW[log-worker]
        SW[score-worker]
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
