# Whalo Backend Exam — Mobile Game Microservices

A Node.js / TypeScript microservices backend for a mobile game, built around four HTTP services and two background workers. It demonstrates event-driven design, retry-safe async pipelines, Redis-backed real-time rankings, and horizontally scalable workers with rate control.

- **Async write paths** — `/scores` and `/logs` return `202` immediately; persistence happens via RabbitMQ → batch worker.
- **Redis is the source of truth for rankings** — MongoDB is only the durable backup + cold-start backfill.
- **Idempotent by construction** — retries are safe at every layer (Mongo unique index, scoped `$inc`, idempotent Lua).
- **Eventually consistent fan-out** — `player.*` events keep `scores`, `playerscores`, and Redis in sync without blocking the write path.

---

## Architecture at a glance

```
Client → Player Service      (:3001) → MongoDB
                                      → RabbitMQ player_events ─┐
                                                                │
       → Score Service       (:3002) → Redis (immediate top-10 via Lua)
                                      → RabbitMQ score_events ──┼─▶ Score Worker
                                      ← RabbitMQ player_events ─┘       → insertMany scores
                                                                        → bulkWrite playerscores ($inc)
                                                                        → Redis ZINCRBY + Lua top-10

       → Leaderboard Service (:3003) → Redis ZREVRANGE leaderboard
                                      → MongoDB (cold-start backfill, guarded by distributed lock)

       → Log Service         (:3004) → RabbitMQ logs_queue (x-max-priority=3) ─▶ Log Worker → MongoDB
```

| Service | Port | Responsibility |
|---|---|---|
| Player Service | 3001 | CRUD player profiles; publishes `player.created / username_updated / deleted` |
| Score Service | 3002 | Accepts score submissions (`202`), serves top-10 from Redis, consumes `player_events` |
| Leaderboard Service | 3003 | Paginated leaderboard served from a Redis sorted set |
| Log Service | 3004 | Validates and fans log events into a priority queue (`202`) |
| Score Worker | — | Batches `score_events` → durable writes + Redis ranking updates |
| Log Worker | — | Batches `logs_queue` → `insertMany` to MongoDB |

Full architecture diagrams, sequence flows, and schema: [docs/architecture.md](docs/architecture.md).

---

## Tech stack

Node.js 20 · TypeScript (strict) · Express · MongoDB Atlas (Mongoose) · Redis 7 (sorted sets, hashes, Lua) · RabbitMQ 3 (durable + priority queues) · Zod · Docker Compose · npm workspaces.

---

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/AmitOfir4/Whalo-Backend-Exam.git
cd Whalo-Backend-Exam
cp .env.example .env                  # fill in MONGO_URI
docker compose up --build
```

Starts Redis (`6379`), RabbitMQ (`5672`, UI on `15672` — guest/guest), all four API services, and both workers.

### Local development

```bash
npm install
npm run build --workspace=shared
cp .env.example .env

# In separate terminals (requires MongoDB, Redis, RabbitMQ running locally):
npm run dev:player
npm run dev:score
npm run dev:leaderboard
npm run dev:log
npm run dev:worker          # log worker
npm run dev:score-worker    # score worker
```

---

## API surface

| Method | Endpoint | Service | Notes |
|---|---|---|---|
| POST | `/players` | Player | `201` on success |
| GET | `/players` | Player | Paginated (`?page=&limit=`, max 100) |
| GET | `/players/:playerId` | Player | |
| PUT | `/players/:playerId` | Player | Publishes `player.username_updated` when applicable |
| DELETE | `/players/:playerId` | Player | Publishes `player.deleted` |
| POST | `/scores` | Score | **202** — top-10 updated synchronously via Lua; durable write async |
| GET | `/scores/top` | Score | Top 10 from Redis (`top10scores:set` + `top10scores:data`) |
| GET | `/players/leaderboard` | Leaderboard | Paginated; O(log N + M) via `ZREVRANGE` |
| POST | `/logs` | Log | **202** — routed through priority queue |
| GET | `/health` | all | `{ status: "ok", service: "<name>" }` |

Full request/response reference: [docs/api-docs.md](docs/api-docs.md).
Postman collection: [`postman/Whalo-Backend.postman_collection.json`](postman/Whalo-Backend.postman_collection.json).

---

## The score pipeline — async, idempotent, three-layer safe

```
POST /scores
  │
  ▼
Score Service
  ├─▶ Redis HGET leaderboard:usernames   (Mongo fallback on miss, then HSET to warm)
  ├─▶ scoreKey = playerId:timestamp
  ├─▶ Lua: ZADD top10scores:set + HSET top10scores:data   ← instant top-10 visibility
  ├─▶ Publish score.submitted → score_events
  └─▶ 202 { playerId, username, score }

Score Worker (batched)
  ├─▶ insertMany(scores, { ordered: false })              ← unique {playerId, createdAt} absorbs duplicates
  ├─▶ identify newBatch = non-duplicate inserts
  ├─▶ bulkWrite(playerscores $inc totalScore/gamesPlayed) ← scoped to newBatch only
  ├─▶ Redis pipeline: ZINCRBY leaderboard + Lua top-10    ← scoped to newBatch only
  └─▶ ACK the whole batch (NACK + requeue on any failure)
```

Retry safety is enforced independently at each layer:

- **MongoDB `scores`** — unique compound index on `{playerId, createdAt}` turns a redelivered message into a silent `E11000`; we filter the response down to genuinely new inserts.
- **MongoDB `playerscores`** — `$inc` only runs for those new inserts, so `totalScore` / `gamesPlayed` never double-count on redelivery.
- **Redis** — `ZINCRBY` and the top-10 Lua script are also scoped to new inserts. The script uses the same `scoreKey = playerId:timestamp` in both the HTTP and worker paths; `ZADD` for the same member is idempotent, so re-running never produces duplicates.

---

## Player events — fan-out that keeps everything in sync

Player Service publishes lifecycle events; Score Service consumes them so denormalized state in `scores`, `playerscores`, and Redis stays consistent — without blocking the HTTP write path.

| Event | Handler (Score Service consumer) |
|---|---|
| `player.created` | Upserts `playerscores` with `totalScore: 0`; `HSET leaderboard:usernames` |
| `player.username_updated` | Cascades the new username to `scores`, `playerscores`, and the Redis username hash in parallel |
| `player.deleted` | Deletes `playerscores`, all `scores`, `ZREM leaderboard`, `HDEL leaderboard:usernames`; runs an atomic Lua script that scans the ≤10-entry top-scores set and removes every `playerId:*` member from both the set and the data hash in one round-trip |

---

## The log pipeline — async with priority

```
POST /logs {priority?: low|normal|high}
  │
  ▼
Log Service → RabbitMQ logs_queue (x-max-priority=3) → 202 Accepted

Log Worker (batched)
  ├─▶ Batcher           — flush at BATCH_SIZE (50) or BATCH_INTERVAL_MS (2000ms)
  ├─▶ Token Bucket      — capacity 10, refill 5/s — caps sustained write rate
  ├─▶ Semaphore         — MAX_CONCURRENT_WRITES=3 — caps parallel Mongo writes
  ├─▶ insertMany(logs, { ordered: false })
  └─▶ ACK after successful write (at-least-once)
```

**Priority-aware flushing:** when any message in the buffer is `high` priority, the Log Worker shrinks its flush threshold by 5× and its timer by 4×, so high-priority logs clear the queue well before the normal 50-message / 2-second window closes.

Both workers **scale horizontally** (`docker compose up --scale log-worker=3 --scale score-worker=5`) and handle `SIGTERM` / `SIGINT`: cancel the consumer, drain in-flight flushes, exit cleanly.

---

## Leaderboard cold-start — guarded with a distributed lock

On an empty Redis sorted set (fresh boot or Redis restart), the Leaderboard Service backfills from `playerscores`. To avoid a thundering-herd where N instances all run the same expensive scan, the service takes a Redis `SET leaderboard:backfill:lock <instance> NX PX 30000` lock:

- **Holder** — runs the backfill, populates the sorted set + username hash.
- **Losers** — wait 300 ms then retry; by then the sorted set is warm and they hit the fast path.

The lock is released on completion; the 30s TTL is a safety net against crashes.

---

## Project layout

```
├── services/
│   ├── player-service/         # CRUD + player_events publisher
│   ├── score-service/          # /scores + /scores/top + player_events consumer
│   ├── leaderboard-service/    # /players/leaderboard (Redis ZREVRANGE + cold-start lock)
│   ├── log-service/            # /logs → priority queue publisher
│   ├── log-worker/             # logs_queue consumer → batched Mongo writes
│   └── score-worker/           # score_events consumer → Mongo + Redis writes
├── shared/                     # DB/Redis/RabbitMQ clients, Zod middleware,
│                               # error handler, graceful-shutdown, distributed lock,
│                               # queue/Redis-key constants, shared types
├── docs/
│   ├── architecture.md         # Mermaid diagrams + ER schema
│   ├── api-docs.md             # Endpoint reference
│   └── scaling-guidelines.md   # Scaling strategies
├── postman/                    # Postman collection
├── stress-test/                # k6 load test + runner
├── docker-compose.yml
├── .env.example
└── tsconfig.base.json
```

---

## Stress test

[k6](https://k6.io/) script that exercises all four services simultaneously with a ramping profile (5 min total, 130 VUs peak).

| Scenario | VUs | Target | Peak |
|---|---|---|---|
| `score_submissions` | 50 | `POST /scores` | ~500 req/s |
| `leaderboard_reads` | 40 | `GET /players/leaderboard` | ~800 req/s |
| `top_scores_reads` | 25 | `GET /scores/top` | ~500 req/s |
| `log_ingestion` | 15 | `POST /logs` | ~75 req/s |

Stages: 2 min ramp-up → 2 min hold → 1 min ramp-down per scenario.

Thresholds (test fails if breached): global `p(95) < 2 s`, `p(99) < 5 s`, error rate `< 5 %`, leaderboard + top-scores `p(95) < 500 ms`, score submit `p(95) < 1.5 s`.

```bash
brew install k6                 # macOS
docker compose up -d
k6 run stress-test/stress.js    # or ./stress-test/run.sh [--summary]
```

Override targets with `PLAYER_URL` / `SCORE_URL` / `LEADERBOARD_URL` / `LOG_URL` env vars.

---

## Scaling

[docs/scaling-guidelines.md](docs/scaling-guidelines.md) covers: horizontal scaling behind a load balancer, MongoDB replica sets + sharding + index map, Redis Sentinel/Cluster + AOF, RabbitMQ clustering, worker tuning presets, and an AWS deployment reference.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `MONGO_URI` | — | MongoDB Atlas connection string |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ connection string |
| `PLAYER_SERVICE_PORT` | `3001` | Player service port |
| `SCORE_SERVICE_PORT` | `3002` | Score service port |
| `LEADERBOARD_SERVICE_PORT` | `3003` | Leaderboard service port |
| `LOG_SERVICE_PORT` | `3004` | Log service port |
| `BATCH_SIZE` | `50` | Worker flush-by-size threshold |
| `BATCH_INTERVAL_MS` | `2000` | Worker flush-by-time threshold |
| `MAX_CONCURRENT_WRITES` | `3` | Semaphore cap — parallel DB writes |
| `TOKEN_BUCKET_CAPACITY` | `10` | Token bucket burst capacity |
| `TOKEN_BUCKET_REFILL_RATE` | `5` | Tokens refilled per second |

The log and score workers share the same four rate-control env vars.
