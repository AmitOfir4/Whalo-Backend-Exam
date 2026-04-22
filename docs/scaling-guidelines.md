# Scaling Guidelines

This document outlines strategies for scaling the Whalo mobile game backend to handle increased traffic and data volume.

---

## 1. Horizontal Scaling — Stateless Services

All microservices are designed to be **stateless** — they do not store session data in memory. This enables:

- **Multiple instances** of each service behind a load balancer
- **Container orchestration** with Kubernetes or AWS ECS
- **Auto-scaling** based on CPU/memory usage or request count

### Load Balancing Strategy

```
                    ┌─────────────────┐
   Client ────────▶│  Load Balancer   │
                    │  (NGINX / ALB)   │
                    └────┬───┬───┬────┘
                         │   │   │
              ┌──────────┤   │   ├──────────┐
              ▼          ▼   ▼   ▼          ▼
         Service-1  Service-2  Service-3  Service-N
```

**Recommended:** AWS Application Load Balancer (ALB) or NGINX with round-robin distribution.

---

## 2. Database Scaling — MongoDB

### Indexing (Already Implemented)
- `players.playerId` — unique index for O(1) lookups
- `players.email` — unique index for duplicate detection
- `players.username` — unique index for duplicate detection
- `scores.score` — descending index for top scores query
- `scores.playerId` — index for per-player queries
- `scores.{ playerId, createdAt }` — unique compound index; makes `insertMany` retries idempotent by absorbing duplicate-key errors so only genuinely new inserts drive `$inc` and Redis writes
- `playerscores.totalScore` — descending index for aggregation fallback
- `logs.playerId` — index for log filtering

### Read Replicas
Deploy MongoDB replica sets to distribute read queries:
- **Primary**: handles writes
- **Secondary**: handles read-heavy queries like leaderboard and top scores
- Configure `readPreference: 'secondaryPreferred'` in Mongoose

### Sharding
For very large datasets, shard the `scores` collection:
- **Shard key**: `playerId` (ensures all scores for a player are on the same shard)
- Enables horizontal scaling of the data layer

> **Note:** The leaderboard reads exclusively from Redis — MongoDB `playerscores` is the durable backup, not the read path. Sharding `playerscores` on `playerId` keeps cold-start backfill efficient.

### Connection Pooling
Mongoose manages connection pools by default. For high-load scenarios:
```typescript
mongoose.connect(uri, {
  maxPoolSize: 50,       // Increase from default 5
  minPoolSize: 10,
  maxIdleTimeMS: 30000,
});
```

---

## 3. Caching & Ranking — Redis Layer

Redis is already integrated as a core part of the system, not an optional add-on. It serves two distinct roles:

### Leaderboard Sorted Set (Primary Ranking Store)
The leaderboard is backed by a Redis Sorted Set — not MongoDB aggregation.

```
POST /scores → Score Service
  ├─ Publish score.submitted → score_events
  └─ Lua: SET NX applied:leaderboard:<scoreKey> → ZINCRBY leaderboard   (sync, immediate visibility)

                    │
                    ▼  (async durability path)

Score Worker → batched consume of score_events
  ├─ insertMany scores + bulkWrite playerscores $inc                    (durable aggregation)
  └─ Same idempotent Lua — no-op if service already applied             (catch-up if service crashed mid-request)
```

- `ZINCRBY` updates the sorted set atomically and in O(log N)
- `ZREVRANGE` serves paginated reads in O(log N + M)
- The Score Service writes to the sorted set synchronously so visible ranking doesn't wait for queue drain under load; correctness is preserved by an **idempotency marker** (`applied:leaderboard:<scoreKey>`) that gates the `ZINCRBY` so both the service and the worker running the same script for the same message is safe. Marker TTL is configurable via `LEADERBOARD_APPLIED_TTL_SECONDS` — must exceed the worst-case worker lag (24h default is conservative for any realistic queue depth)
- On cold start (empty sorted set) the leaderboard service backfills from the `playerscores` MongoDB collection
- A **distributed Redis lock** (`SET NX PX`) prevents thundering herd when multiple instances start simultaneously — only the lock holder runs the backfill; concurrent instances wait 300 ms and return
- No TTL on the sorted set itself — it is the source of truth for rankings

### Top Scores (Redis Sorted Set — Always Fresh)
The top-10 individual scores are maintained in a Redis Sorted Set (`top10scores:set`) and a companion Hash (`top10scores:data`). This is **not a cache with a TTL** — the sorted set is always up to date.

```
POST /scores → Score Service → Lua script: ZADD top10scores:set (immediate, on HTTP path)
                             → score_events queue → Score Worker
                               → Lua script: ZADD top10scores:set (idempotent, same scoreKey)

GET /scores/top → ZREVRANGE top10scores:set 0 9 → HMGET top10scores:data (no MongoDB, no cache)
```

- The Lua script is executed atomically in both the service (for immediate visibility) and the worker (for durability after batch write)
- The same `scoreKey = playerId:timestamp` ensures both executions are idempotent — no duplicate entries
- On cold start (empty sorted set after Redis restart), the service hydrates from MongoDB automatically via `hydrateTopScoresFromMongo()`

### Known-Players SET
Score-service uses a Redis SET (`players:known`) to gate `POST /scores` — `SISMEMBER` is O(1) and keeps the submit path off both MongoDB and `player-service`. The set is maintained incrementally by the `player_events` consumer (`SADD` on `player.created`, `SREM` on `player.deleted`) and hydrated on cold-start from the `playerscores` collection under a distributed lock, so restarting Redis never opens a window for `POST /scores` to accept submissions for nonexistent players.

Display names are intentionally *not* cached here — `/scores/top` and `/players/leaderboard` return `playerId` only, and clients resolve usernames in a single batched call to `GET /players?ids=...` against `player-service`. This keeps the score and leaderboard services on a single data store (Redis) and avoids denormalizing a player-service-owned field into score-service's state.

### Redis Scaling
- For high availability, use **Redis Sentinel** (automatic failover) or **Redis Cluster** (horizontal sharding)
- Persistence: enable **AOF** (`appendonly yes`) to survive restarts without losing ranking data
- Memory: allocate enough RAM to hold the full sorted set — at 1M players this is roughly 64 MB

---

## 4. Message Queue Scaling — RabbitMQ

### Multiple Workers
Scale the log-worker and score-worker horizontally — each instance consumes from the same queue independently:

```yaml
# docker-compose scale command
docker-compose up --scale log-worker=3
docker-compose up --scale score-worker=5
```

RabbitMQ automatically distributes messages across consumers using round-robin.

### Priority Queue (Log Worker)
The `logs_queue` is declared with `x-max-priority: 3`, mapping to:

| Priority | AMQP Value |
|----------|-----------|
| `high`   | 3         |
| `normal` | 2         |
| `low`    | 1         |

High-priority logs are consumed before lower-priority ones within the same consumer's prefetch window.

**Priority-aware flushing** on the worker side: when the log worker's buffer contains any `high` priority message, its flush threshold shrinks from `BATCH_SIZE` → `BATCH_SIZE / 5` and its flush interval from `BATCH_INTERVAL_MS` → `BATCH_INTERVAL_MS / 4`. High-priority logs therefore reach MongoDB well ahead of the normal flush window, even under moderate load — without sacrificing the throughput benefit of batching when only `normal`/`low` traffic is present.

### RabbitMQ Clustering
For high availability, deploy a RabbitMQ cluster with mirrored queues:
- 3-node cluster minimum
- Quorum queues for durability
- Configure `ha-mode: all` for high availability

### Tuning Worker Performance
Both the **log worker** and **score worker** share the same configurable tuning variables:

| Variable | Low Load | Medium Load | High Load |
|----------|----------|-------------|-----------|
| BATCH_SIZE | 10 | 50 | 200 |
| BATCH_INTERVAL_MS | 5000 | 2000 | 500 |
| MAX_CONCURRENT_WRITES | 1 | 3 | 10 |
| TOKEN_BUCKET_CAPACITY | 5 | 10 | 50 |
| TOKEN_BUCKET_REFILL_RATE | 2 | 5 | 20 |

The score worker's batch flush runs `insertMany` (scores) first to identify genuinely new inserts, then runs `bulkWrite` (playerscores `$inc`) and the Redis pipeline (leaderboard + top scores) **in parallel but only for those new inserts** — so a larger `BATCH_SIZE` amortizes the cost of all three operations and prevents any double-counting on retry.

---

## 5. Service Mesh & API Gateway

For production deployments, consider adding:

### API Gateway (e.g., Kong, AWS API Gateway)
- **Single entry point** for all services
- **Rate limiting** at the gateway level
- **Authentication/authorization** (JWT validation)
- **Request routing** based on path prefix
- **SSL termination**

### Service Discovery
With Kubernetes or Docker Swarm:
- Services discover each other by name
- Automatic load balancing within the cluster
- Health checks and automatic restart of failed containers

---

## 6. Monitoring & Observability

### Recommended Stack
- **Metrics**: Prometheus + Grafana
- **Logging**: ELK Stack (Elasticsearch, Logstash, Kibana)
- **Tracing**: Jaeger or AWS X-Ray

### Key Metrics to Monitor
- Request latency (p50, p95, p99) per service
- RabbitMQ queue depth for `score_events` and `logs_queue` (indicates worker lag)
- MongoDB operation latency and connection pool usage
- Error rates per endpoint
- Log worker and score worker batch sizes and flush frequency
- Worker graceful shutdown drain time (time between SIGTERM and process exit)

---

## 7. Deployment Architecture (AWS Example)

```
                        ┌─────────────────────┐
                        │    Route 53 (DNS)    │
                        └──────────┬──────────┘
                                   │
                        ┌──────────▼──────────┐
                        │   ALB (Load Balancer)│
                        └──┬───┬───┬───┬──────┘
                           │   │   │   │
                    ┌──────┤   │   │   ├──────┐
                    ▼      ▼   ▼   ▼   ▼      ▼
              ┌─────────┐ ┌──────┐ ┌──────┐ ┌──────┐
              │ ECS     │ │ ECS  │ │ ECS  │ │ ECS  │
              │ Player  │ │Score │ │Leader│ │ Log  │
              │ Service │ │Svc   │ │board │ │ Svc  │
              └────┬────┘ └──┬───┘ └──┬───┘ └──┬───┘
                   │         │        │        │
              ┌────▼─────────▼────────▼────┐   │
              │    DocumentDB / MongoDB    │   │
              │    Atlas (Managed)         │   │
              └────────────────────────────┘   │
                                               │
                                    ┌──────────▼──────┐
                                    │  Amazon MQ      │
                                    │  (RabbitMQ)     │
                                    └──────┬──────────┘
                                           │        │
                               ┌───────────▼──┐  ┌──▼───────────┐
                               │  ECS         │  │  ECS         │
                               │  Log Workers │  │  Score       │
                               │  (scaled)    │  │  Workers     │
                               └──────────────┘  └──────────────┘
```

### AWS Services Mapping
| Component | AWS Service |
|-----------|-------------|
| Microservices | ECS Fargate (serverless containers) |
| MongoDB | MongoDB Atlas |
| Redis | ElastiCache for Redis |
| RabbitMQ | Amazon MQ |
| Load Balancer | Application Load Balancer |
| DNS | Route 53 |
| Secrets | AWS Secrets Manager |
| Monitoring | CloudWatch + X-Ray |
