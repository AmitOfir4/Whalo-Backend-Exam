import dotenv from 'dotenv';
import { connectDB, connectRedis } from '@whalo/shared';
import { startConsumer } from './consumer';

dotenv.config({ path: '../../.env' });

const MONGO_URI = process.env.MONGO_URI || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

async function start(): Promise<void>
{
  await connectDB(MONGO_URI);
  connectRedis(REDIS_URL);
  await startConsumer(RABBITMQ_URL);
  console.log('Score Worker is running');
}

start().catch((error) =>
{
  console.error('Score Worker failed to start:', error);
  process.exit(1);
});
