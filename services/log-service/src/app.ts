import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { errorHandler, onShutdown, AppError } from '@whalo/shared';
import { connectQueue, closeQueue } from './queue/publisher';
import logRoutes from './routes/log.routes';

dotenv.config({ path: '../../.env' });

const app = express();
const PORT = process.env.LOG_SERVICE_PORT || 3004;
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/logs', logRoutes);

app.get('/health', (_req, res) =>
{
  res.json({ status: 'ok', service: 'log-service' });
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
  await connectQueue(RABBITMQ_URL);

  const server = app.listen(PORT, () =>
  {
    console.log(`Log Service running on port ${PORT}`);
  });

  onShutdown(() => new Promise<void>((resolve, reject) =>
  {
    server.close((err) => (err ? reject(err) : resolve()));
  }));
  onShutdown(async () => { await closeQueue(); });
}

start();

export default app;
