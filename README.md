# Whalo Backend Exam — Mobile Game Microservices

A Node.js/TypeScript microservices backend for a mobile game, featuring player management, game scores, leaderboards, and an async log ingestion pipeline.

## Architecture

```
Client → Player Service (:3001)       → MongoDB
       → Score Service  (:3002)       → MongoDB
       → Leaderboard Service (:3003)  → MongoDB (aggregation)
       → Log Service    (:3004)       → RabbitMQ → Log Worker(s) → MongoDB
```

| Service | Port | Description |
|---------|------|-------------|
| Player Service | 3001 | CRUD player profiles |
| Score Service | 3002 | Submit scores, get top 10 |
| Leaderboard Service | 3003 | Aggregated leaderboard with pagination |
| Log Service | 3004 | Receive logs → RabbitMQ (responds 202 instantly) |
| Log Worker | — | Batch-writes logs from RabbitMQ to MongoDB |

**Full architecture diagrams:** [docs/architecture.md](docs/architecture.md)

---

## Tech Stack

- **Runtime**: Node.js 20 + TypeScript
- **Framework**: Express.js
- **Database**: MongoDB 7 (via Mongoose)
- **Message Broker**: RabbitMQ 3
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
- MongoDB on port `27017`
- RabbitMQ on port `5672` (management UI: `http://localhost:15672`, guest/guest)
- All 4 API services + the log worker

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
| GET | `/players/:playerId` | Player | Get player by ID |
| PUT | `/players/:playerId` | Player | Update player |
| DELETE | `/players/:playerId` | Player | Delete player |
| POST | `/scores` | Score | Submit a score |
| GET | `/scores/top` | Score | Top 10 scores |
| GET | `/players/leaderboard` | Leaderboard | Paginated leaderboard |
| POST | `/logs` | Log | Submit log (async) |

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

## Project Structure

```
├── services/
│   ├── player-service/         # CRUD player profiles
│   ├── score-service/          # Score submission + top scores
│   ├── leaderboard-service/    # Aggregated leaderboard
│   ├── log-service/            # HTTP → RabbitMQ publisher
│   └── log-worker/             # RabbitMQ consumer → MongoDB batch writer
├── shared/                     # Shared types, DB helper, middleware
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

1. **Log Service** receives `POST /logs`, validates with Zod, publishes to RabbitMQ, responds `202 Accepted` immediately
2. **Log Worker** consumes from RabbitMQ with three rate-control strategies:
   - **Batcher**: Aggregates messages, flushes via `insertMany()` when buffer hits 50 messages or 2-second timer
   - **Token Bucket**: Rate-limits write frequency (configurable capacity + refill rate)
   - **Semaphore**: Limits concurrent database write operations (default: max 3)
3. Messages are only ACK'd after successful database write (at-least-once delivery)
4. Workers can be scaled horizontally: `docker-compose up --scale log-worker=3`

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
| `MONGO_URI`| MongoDB connection string |
| `RABBITMQ_URL` | `amqp://guest:guest@localhost:5672` | RabbitMQ connection string |
| `PLAYER_SERVICE_PORT` | `3001` | Player service port |
| `SCORE_SERVICE_PORT` | `3002` | Score service port |
| `LEADERBOARD_SERVICE_PORT` | `3003` | Leaderboard service port |
| `LOG_SERVICE_PORT` | `3004` | Log service port |
| `BATCH_SIZE` | `50` | Log worker batch size |
| `BATCH_INTERVAL_MS` | `2000` | Log worker flush interval (ms) |
| `MAX_CONCURRENT_WRITES` | `3` | Max parallel DB writes |
| `TOKEN_BUCKET_CAPACITY` | `10` | Token bucket capacity |
| `TOKEN_BUCKET_REFILL_RATE` | `5` | Tokens refilled per second |