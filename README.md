# Whalo Backend Exam — Mobile Game Microservices

A Node.js/TypeScript microservices backend for a mobile game, featuring player management, game scores, leaderboards, and an async log ingestion pipeline.

## Architecture

```
Client → Player Service  (:3001)  → MongoDB Atlas
                                  → RabbitMQ (player_events) → Score Service (consumer)
                                                              → playerscores + Redis hash

       → Score Service   (:3002)  → Redis (username cache)
                                  → RabbitMQ (score_events) → Score Worker (Batcher)
                                                            → insertMany scores
                                                            → bulkWrite playerscores
                                                            → Redis pipeline (leaderboard + top scores)

       → Leaderboard Service (:3003) → Redis (ZREVRANGE leaderboard sorted set)
                                     → MongoDB Atlas (cold-start backfill only)

       → Log Service     (:3004)  → RabbitMQ (logs_queue, priority queue) → Log Worker(s) → MongoDB Atlas
```

| Service | Port | Description |
|---------|------|-------------|
| Player Service | 3001 | CRUD player profiles, publishes player lifecycle events |
| Score Service | 3002 | Submit scores (202 — immediate top-scores update, full persistence async), get top 10 |
| Leaderboard Service | 3003 | Redis sorted set leaderboard with pagination |
| Log Service | 3004 | Receive logs → RabbitMQ priority queue (responds 202 instantly) |
| Log Worker | — | Batch-writes logs from RabbitMQ to MongoDB |
| Score Worker | — | Batches `score_events` → `insertMany` scores, `bulkWrite` playerscores, Redis leaderboard + top scores |

**Full architecture diagrams:** [docs/architecture.md](docs/architecture.md)

---

## Tech Stack

- **Runtime**: Node.js 20 + TypeScript
- **Framework**: Express.js
- **Database**: MongoDB Atlas (via Mongoose)
- **Cache & Ranking**: Redis 7 (sorted sets, hash, string cache)
- **Message Broker**: RabbitMQ 3 (durable queues + priority queue)
- **Validation**: Zod
- **Containerization**: Docker + Docker Compose
- **Monorepo**: npm workspaces

---

## Quick Start

### Prerequisites
- [Docker](https://www.docker.com/) and Docker Compose installed

### Run with Docker

```bash
# Clone the repository
git clone https://github.com/AmitOfir4/Whalo-Backend-Exam.git
cd Whalo-Backend-Exam

# Start all services
docker-compose up --build
```

This starts:
- Redis on port `6379`
- RabbitMQ on port `5672` (management UI: `http://localhost:15672`, guest/guest)
- All 4 API services + log worker + score worker

### Run Locally (Development)

```bash
# Install dependencies
npm install

# Build shared package
npm run build --workspace=shared

# Copy environment file
cp .env.example .env

# Start services individually (requires MongoDB + RabbitMQ running locally)
npm run dev:player
npm run dev:score
npm run dev:leaderboard
npm run dev:log
npm run dev:worker
```

---

## API Endpoints

| Method | Endpoint | Service | Description |
|--------|----------|---------|-------------|
| POST | `/players` | Player | Create player |
| GET | `/players` | Player | List all players |
| GET | `/players/:playerId` | Player | Get player by ID |
| PUT | `/players/:playerId` | Player | Update player |
| DELETE | `/players/:playerId` | Player | Delete player |
| POST | `/scores` | Score | Submit a score (202 async) |
| GET | `/scores/top` | Score | Top 10 scores (Redis sorted set, always fresh) |
| GET | `/players/leaderboard` | Leaderboard | Paginated leaderboard (Redis sorted set) |
| POST | `/logs` | Log | Submit log (async, supports priority) |

**Full API documentation:** [docs/api-docs.md](docs/api-docs.md)

---

## Postman Collection

Import the Postman collection for ready-to-use API requests:

📁 [`postman/Whalo-Backend.postman_collection.json`](postman/Whalo-Backend.postman_collection.json)

The collection includes:
- All endpoints with example request bodies
- Auto-extraction of `playerId` from create response
- Validation error examples
- Health check requests
- Collection variables for base URLs

---

## Score Pipeline — Async Processing

Score submission is split between an immediate synchronous path and an async batch path:

1. **Score Service** receives `POST /scores`, validates with Zod, checks player via Redis hash (falls back to MongoDB), generates a `timestamp` → `scoreKey = playerId:timestamp`, then **in parallel**:
   - Runs an atomic Lua script to update `top10scores:set` / `top10scores:data` in Redis **immediately** (instant top-scores visibility)
   - Publishes `score.submitted` (with `timestamp`) to the `score_events` queue
   - Responds `202 Accepted` with `{ playerId, username, score }`
2. **Score Worker** buffers messages via a `Batcher` and on each flush:
   - `insertMany({ordered:false})` to the `scores` collection — a unique compound index on `{ playerId, createdAt }` absorbs duplicate-key errors on retry, identifying only *genuinely new* inserts
   - `bulkWrite` (`$inc totalScore`, `$inc gamesPlayed`) to `playerscores` **only for new inserts** — prevents double-counting on redelivery
   - Redis pipeline: `ZINCRBY leaderboard` + same Lua top-scores script — also scoped to new inserts only
3. Messages are ACK'd only after all writes succeed; on failure the whole batch is nack'd and requeued — retry is safe at all three layers (MongoDB unique index, scoped `$inc`, idempotent Lua script)

---

## Player Events — Async Propagation

Player lifecycle changes propagate asynchronously via the `player_events` queue consumed by Score Service:

| Event | Effect |
|-------|--------|
| `player.created` | Seeds `playerscores` entry; caches username in Redis |
| `player.username_updated` | Cascades new username to `scores`, `playerscores`, Redis hash |
| `player.deleted` | Removes `playerscores`, all `scores`, Redis leaderboard entry, Redis username entry; atomically removes all `playerId:*` top-score entries from `top10scores:set` and `top10scores:data` via Lua script |

---

## Project Structure

```
├── services/
│   ├── player-service/         # CRUD player profiles + player_events publisher
│   ├── score-service/          # Score submission + top scores + player_events consumer
│   ├── leaderboard-service/    # Redis sorted set leaderboard
│   ├── log-service/            # HTTP → RabbitMQ priority queue publisher
│   ├── log-worker/             # RabbitMQ consumer → MongoDB batch writer
│   └── score-worker/           # score_events consumer → playerscores + Redis sorted set
├── shared/                     # Shared types, DB/Redis helpers, middleware, constants
├── docs/
│   ├── architecture.md         # Mermaid diagrams
│   ├── api-docs.md             # Endpoint reference
│   └── scaling-guidelines.md   # Scaling strategies
├── postman/                    # Postman collection
├── docker-compose.yml
├── .env.example
└── tsconfig.base.json
```

---

## Log Pipeline — Async Processing

The log system implements a production-grade async pipeline:

1. **Log Service** receives `POST /logs` (with optional `priority`: `low | normal | high`), validates with Zod, publishes to RabbitMQ **priority queue** (`x-max-priority: 3`), responds `202 Accepted` immediately
2. **Log Worker** consumes from RabbitMQ with three rate-control strategies:
   - **Batcher**: Aggregates messages, flushes via `insertMany()` when buffer hits 50 messages or 2-second timer
   - **Token Bucket**: Rate-limits write frequency (configurable capacity + refill rate)
   - **Semaphore**: Limits concurrent database write operations (default: max 3)
3. Messages are only ACK'd after successful database write (at-least-once delivery)
4. **Workers can be scaled horizontally**: `docker-compose up --scale log-worker=3` / `--scale score-worker=5`
5. Both workers handle `SIGTERM` and `SIGINT` — they cancel their RabbitMQ consumer, flush/drain all in-progress writes, then exit cleanly

---

## Scaling

See [docs/scaling-guidelines.md](docs/scaling-guidelines.md) for detailed strategies covering:

- Horizontal scaling with load balancers
- MongoDB replica sets, sharding, and connection pooling
- Redis caching layer for leaderboard/top scores
- RabbitMQ clustering and worker scaling
- AWS deployment architecture

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONGO_URI` | — | MongoDB Atlas connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ connection string |
| `PLAYER_SERVICE_PORT` | `3001` | Player service port |
| `SCORE_SERVICE_PORT` | `3002` | Score service port |
| `LEADERBOARD_SERVICE_PORT` | `3003` | Leaderboard service port |
| `LOG_SERVICE_PORT` | `3004` | Log service port |
| `BATCH_SIZE` | `50` | Log worker batch size |
| `BATCH_INTERVAL_MS` | `2000` | Log worker flush interval (ms) |
| `MAX_CONCURRENT_WRITES` | `3` | Max parallel DB writes (log worker) |
| `TOKEN_BUCKET_CAPACITY` | `10` | Token bucket capacity (log worker) |
| `TOKEN_BUCKET_REFILL_RATE` | `5` | Tokens refilled per second (log worker) |