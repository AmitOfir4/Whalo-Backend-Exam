import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { connectDB, errorHandler, onShutdown, AppError } from '@whalo/shared';
import playerRoutes from './routes/player.routes';
import { connectQueue, closeQueue } from './queue/publisher';

dotenv.config({ path: '../../.env' });

const app = express();
const PORT = process.env.PLAYER_SERVICE_PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/players', playerRoutes);

app.get('/health', (_req, res) =>
{
  res.json({ status: 'ok', service: 'player-service' });
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
  await connectQueue(RABBITMQ_URL);

  const server = app.listen(PORT, () =>
  {
    console.log(`Player Service running on port ${PORT}`);
  });

  // Shutdown hooks run in reverse-registration order: HTTP first (stops new
  // requests coming in), then the publisher (drains confirms), then Mongo.
  onShutdown(() => new Promise<void>((resolve, reject) =>
  {
    server.close((err) => (err ? reject(err) : resolve()));
  }));
  onShutdown(async () => { await closeQueue(); });
  onShutdown(async () => { await mongoose.disconnect(); });
}

start();

export default app;
