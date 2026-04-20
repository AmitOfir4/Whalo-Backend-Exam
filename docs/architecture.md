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
    end

    subgraph Storage["Data Layer"]
        MongoDB[(MongoDB<br/>:27017)]
    end

    Client -->|CRUD /players| PS
    Client -->|POST /scores<br/>GET /scores/top| SS
    Client -->|GET /players/leaderboard| LS
    Client -->|POST /logs| LGS

    PS -->|Read/Write players| MongoDB
    SS -->|Read/Write scores| MongoDB
    LS -->|Aggregate scores + lookup players| MongoDB
    LGS -->|Publish log message| RMQ
    RMQ -->|Consume messages| LW
    LW -->|Batch insertMany()| MongoDB
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

    C->>LS: POST /logs {playerId, logData}
    LS->>LS: Validate with Zod
    LS->>RMQ: Publish to logs_queue
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

## Leaderboard Aggregation Pipeline

```mermaid
graph LR
    SC[(scores collection)]
    
    SC --> G["$group<br/>{_id: playerId,<br/>totalScore: {$sum: score},<br/>gamesPlayed: {$sum: 1}}"]
    G --> S["$sort<br/>{totalScore: -1}"]
    S --> SK["$skip<br/>(page - 1) × limit"]
    SK --> L["$limit<br/>limit"]
    L --> LK["$lookup<br/>players collection<br/>→ username"]
    LK --> P["$project<br/>{playerId, username,<br/>totalScore, gamesPlayed}"]
    P --> RES[Paginated Response]
```

---

## Database Schema

```mermaid
erDiagram
    PLAYERS {
        string playerId PK "UUID v4"
        string username
        string email UK
        datetime createdAt
        datetime updatedAt
    }

    SCORES {
        ObjectId _id PK
        string playerId FK
        number score
        datetime createdAt
    }

    LOGS {
        ObjectId _id PK
        string playerId FK
        string logData
        datetime receivedAt
        datetime processedAt
    }

    PLAYERS ||--o{ SCORES : "submits"
    PLAYERS ||--o{ LOGS : "generates"
```

---

## Docker Compose Architecture

```mermaid
graph TB
    subgraph DockerNetwork["whalo-network (bridge)"]
        MONGO[mongo:7<br/>:27017]
        RMQ[rabbitmq:3-management<br/>:5672 / :15672]
        PS[player-service<br/>:3001]
        SS[score-service<br/>:3002]
        LS[leaderboard-service<br/>:3003]
        LGS[log-service<br/>:3004]
        LW[log-worker]
    end

    VOL[(mongo-data volume)]

    PS --> MONGO
    SS --> MONGO
    LS --> MONGO
    LGS --> RMQ
    LW --> MONGO
    LW --> RMQ
    MONGO --> VOL
```
