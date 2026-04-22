import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB, connectRedis, getRedis, errorHandler, onShutdown } from '@whalo/shared';
import scoreRoutes from './routes/score.routes';
import { startPlayerEventsConsumer } from './queue/consumer';
import { connectScoreQueue, closeScoreQueue } from './queue/publisher';
import { hydrateTopScoresFromMongo } from './controllers/score.controller';

dotenv.config({ path: '../../.env' });

const app = express();
const PORT = process.env.SCORE_SERVICE_PORT || 3002;
const MONGO_URI = process.env.MONGO_URI || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/scores', scoreRoutes);

app.get('/health', (_req, res) =>
{
  res.json({ status: 'ok', service: 'score-service' });
});

app.use(errorHandler);

async function start(): Promise<void>
{
  await connectDB(MONGO_URI);
  connectRedis(REDIS_URL);
  await connectScoreQueue(RABBITMQ_URL);
  await startPlayerEventsConsumer(RABBITMQ_URL);

  // Cold-start: populate top scores from MongoDB if Redis is empty
  await hydrateTopScoresFromMongo();

  const server = app.listen(PORT, () =>
  {
    console.log(`Score Service running on port ${PORT}`);
  });

  // Hooks run in reverse-registration order: HTTP first, then publisher,
  // then Redis, then Mongo. The consumer registers its own hook.
  onShutdown(() => new Promise<void>((resolve, reject) =>
  {
    server.close((err) => (err ? reject(err) : resolve()));
  }));
  onShutdown(async () => { await closeScoreQueue(); });
  onShutdown(async () => { await getRedis().quit(); });
  onShutdown(async () => { await mongoose.disconnect(); });
}

start();

export default app;
