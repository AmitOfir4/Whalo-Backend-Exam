import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import {
  connectDB,
  connectRedis,
  getRedis,
  errorHandler,
  onShutdown,
  AppError,
  hydrateLeaderboardFromMongo,
} from '@whalo/shared';
import leaderboardRoutes from './routes/leaderboard.routes';

dotenv.config({ path: '../../.env' });

const app = express();
const PORT = process.env.LEADERBOARD_SERVICE_PORT || 3003;
const MONGO_URI = process.env.MONGO_URI || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/players', leaderboardRoutes);

app.get('/health', (_req, res) =>
{
  res.json({ status: 'ok', service: 'leaderboard-service' });
});

// Catch-all for unmatched routes — funnelled through the shared error
// middleware so unknown paths return the same JSON error shape as 4xx/5xx
// responses instead of Express's default HTML "Cannot GET /foo".
app.use((_req, _res, next) =>
{
  next(new AppError('Route not found', 404));
});

app.use(errorHandler);

async function start(): Promise<void>
{
  await connectDB(MONGO_URI);
  connectRedis(REDIS_URL);

  // Cold-start: backfill the leaderboard ZSET from MongoDB before accepting
  // traffic. The helper is sentinel-gated and lock-wrapped, so it's safe to
  // call from multiple replicas and from score-service's startup as well —
  // whoever wins the lock first hydrates, the rest are a single EXISTS check.
  await hydrateLeaderboardFromMongo(getRedis(), mongoose.connection);

  const server = app.listen(PORT, () =>
  {
    console.log(`Leaderboard Service running on port ${PORT}`);
  });

  onShutdown(() => new Promise<void>((resolve, reject) =>
  {
    server.close((err) => (err ? reject(err) : resolve()));
  }));
  onShutdown(async () => { await getRedis().quit(); });
  onShutdown(async () => { await mongoose.disconnect(); });
}

start();

export default app;
