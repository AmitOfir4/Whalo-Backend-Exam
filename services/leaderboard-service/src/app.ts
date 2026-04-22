import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB, connectRedis, getRedis, errorHandler, onShutdown } from '@whalo/shared';
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

app.use(errorHandler);

async function start(): Promise<void>
{
  await connectDB(MONGO_URI);
  connectRedis(REDIS_URL);

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
