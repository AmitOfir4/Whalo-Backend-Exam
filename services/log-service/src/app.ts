import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { errorHandler } from '@whalo/shared';
import { connectQueue } from './queue/publisher';
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

app.use(errorHandler);

async function start(): Promise<void>
{
  await connectQueue(RABBITMQ_URL);
  app.listen(PORT, () =>
  {
    console.log(`Log Service running on port ${PORT}`);
  });
}

start();

export default app;
