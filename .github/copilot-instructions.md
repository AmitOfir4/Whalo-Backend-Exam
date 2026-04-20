# Whalo Backend — Copilot Instructions

These rules apply to every file and every service in this monorepo. Follow them on all code suggestions, edits, and new implementations.

---

## Skills

The following project-level skills **must be loaded and applied** before generating any code:

<skills>
<skill>
<name>allman-code-style</name>
<description>Enforces Allman brace style for all code: opening braces always on their own new line for functions, classes, if/else, loops, try/catch, and switch blocks. ALWAYS load this skill before writing any new code.</description>
<file>.github/copilot/skills/allman-code-style/SKILL.md</file>
</skill>
</skills>

---

## Stack

- **Runtime**: Node.js with **Express.js** for every microservice
- **Language**: **TypeScript** exclusively — no plain `.js` files in `src/`
- **Databases**: **MongoDB** (persistent storage via Mongoose) and **Redis** (caching, sorted sets, pub/sub)
- **Validation**: **Zod** schemas for all request bodies and query parameters
- **Async**: always use **async/await** — no raw `.then()/.catch()` chains
- **Shared code**: place reusable utilities, types, and middleware in `shared/`

---

## API Design

- Use correct **HTTP status codes**:
  - `200` — successful read
  - `201` — successful creation
  - `400` — validation / bad input
  - `404` — resource not found
  - `409` — conflict (e.g. duplicate)
  - `500` — unhandled server error (via error handler)
- All error responses flow through the shared `errorHandler` middleware using `AppError`
- Validate **all** incoming request data at the route level using the shared `validate` / `validateQuery` middleware before it reaches a controller
- Controllers must never throw raw errors — always call `next(error)`

---

## Code Style

- Controllers are thin: parse input, call logic, return response
- No business logic inside route files
- Use `lean()` on Mongoose reads that don't need document methods
- Prefer the raw MongoDB driver (`mongoose.connection.db.collection(...)`) for performance-critical aggregations
- Use `Promise.all` for independent async operations that can run in parallel
- Never block the event loop — no synchronous file I/O or heavy computation in request handlers

---

## Performance & Scalability

- Services are **stateless** — no in-memory state that can't be reconstructed from MongoDB or Redis
- **Redis Sorted Sets** (`ZADD`, `ZINCRBY`, `ZREVRANGE`) are the primary structure for leaderboard-style ranking — never sort a full MongoDB collection for a ranked read
- **Denormalize** frequently-read fields (e.g. `username` on score documents) to avoid `$lookup` joins on hot read paths
- Use **Redis caching** with short TTLs for expensive, read-heavy, rarely-changing queries
- Use **MongoDB connection pooling**: `maxPoolSize: 20`, `minPoolSize: 5`
- Use `estimatedDocumentCount()` instead of `countDocuments()` when exact accuracy is not required (e.g. pagination totals)

---

## Architecture

- Each service is **independently deployable** via its own `Dockerfile`
- Services communicate only through **well-defined HTTP APIs** or **message queues** (RabbitMQ) — never direct database sharing across services
- All services in `docker-compose.yml` use the `whalo-network` bridge and `restart: unless-stopped`
- Infrastructure dependencies (Redis, RabbitMQ) use `healthcheck` + `depends_on: condition: service_healthy`
- Shared types are exported from `@whalo/shared` — never duplicate type definitions across services

---

## Project Structure Convention

```
services/<service-name>/src/
  app.ts              ← Express setup, DB/Redis connection, startup
  controllers/        ← Request handlers only
  routes/             ← Router + middleware wiring
  validators/         ← Zod schemas
  models/             ← Mongoose schemas and models (where applicable)
```
