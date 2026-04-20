import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { connectDB, errorHandler } from '@whalo/shared';
import playerRoutes from './routes/player.routes';
import { connectQueue } from './queue/publisher';

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

app.use(errorHandler);

async function start(): Promise<void>
{
  await connectDB(MONGO_URI);
  await connectQueue(RABBITMQ_URL);
  app.listen(PORT, () =>
  {
    console.log(`Player Service running on port ${PORT}`);
  });
}

start();

export default app;
