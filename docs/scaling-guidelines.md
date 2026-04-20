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
- `scores.score` — descending index for top scores query
- `scores.playerId` — index for leaderboard aggregation
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

## 3. Caching — Redis Layer

Add Redis as a caching layer for frequently accessed, read-heavy data:

### Leaderboard Cache
```
GET /players/leaderboard → Check Redis → if miss → MongoDB aggregation → store in Redis (TTL: 60s)
```

- Leaderboard changes slowly relative to read frequency
- 60-second TTL balances freshness vs performance
- Invalidate cache on new score submission

### Top Scores Cache
```
GET /scores/top → Check Redis → if miss → MongoDB query → store in Redis (TTL: 30s)
```

### Implementation Pattern
```typescript
import Redis from 'ioredis';
const redis = new Redis(process.env.REDIS_URL);

async function getCachedOrFetch<T>(
  key: string,
  ttlSeconds: number,
  fetchFn: () => Promise<T>
): Promise<T> {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const data = await fetchFn();
  await redis.setex(key, ttlSeconds, JSON.stringify(data));
  return data;
}
```

---

## 4. Message Queue Scaling — RabbitMQ

### Multiple Workers
Scale the log-worker horizontally — each instance consumes from the same queue independently:

```yaml
# docker-compose scale command
docker-compose up --scale log-worker=3
```

RabbitMQ automatically distributes messages across consumers using round-robin.

### RabbitMQ Clustering
For high availability, deploy a RabbitMQ cluster with mirrored queues:
- 3-node cluster minimum
- Quorum queues for durability
- Configure `ha-mode: all` for high availability

### Tuning Worker Performance
Adjust environment variables based on load:

| Variable | Low Load | Medium Load | High Load |
|----------|----------|-------------|-----------|
| BATCH_SIZE | 10 | 50 | 200 |
| BATCH_INTERVAL_MS | 5000 | 2000 | 500 |
| MAX_CONCURRENT_WRITES | 1 | 3 | 10 |
| TOKEN_BUCKET_CAPACITY | 5 | 10 | 50 |
| TOKEN_BUCKET_REFILL_RATE | 2 | 5 | 20 |

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
- RabbitMQ queue depth (indicates worker lag)
- MongoDB operation latency and connection pool usage
- Error rates per endpoint
- Log worker batch sizes and flush frequency

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
                                    └──────────┬──────┘
                                               │
                                    ┌──────────▼──────┐
                                    │  ECS Workers    │
                                    │  (Auto-scaling) │
                                    └─────────────────┘
```

### AWS Services Mapping
| Component | AWS Service |
|-----------|-------------|
| Microservices | ECS Fargate (serverless containers) |
| MongoDB | DocumentDB or MongoDB Atlas |
| RabbitMQ | Amazon MQ |
| Load Balancer | Application Load Balancer |
| DNS | Route 53 |
| Secrets | AWS Secrets Manager |
| Monitoring | CloudWatch + X-Ray |
