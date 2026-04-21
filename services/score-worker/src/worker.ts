import dotenv from 'dotenv';
import { connectDB, connectRedis } from '@whalo/shared';
import { startConsumer } from './consumer';
import { BatcherConfig } from './strategies/batcher';

dotenv.config({ path: '../../.env' });

const MONGO_URI = process.env.MONGO_URI || '';
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

const config: BatcherConfig = {
  batchSize: Number(process.env.BATCH_SIZE) || 50,
  batchIntervalMs: Number(process.env.BATCH_INTERVAL_MS) || 2000,
  maxConcurrentWrites: Number(process.env.MAX_CONCURRENT_WRITES) || 3,
  tokenBucketCapacity: Number(process.env.TOKEN_BUCKET_CAPACITY) || 10,
  tokenBucketRefillRate: Number(process.env.TOKEN_BUCKET_REFILL_RATE) || 5,
};

async function start(): Promise<void>
{
  await connectDB(MONGO_URI);
  connectRedis(REDIS_URL);
  await startConsumer(RABBITMQ_URL, config);
  console.log('Score Worker is running');
}

start().catch((error) =>
{
  console.error('Score Worker failed to start:', error);
  process.exit(1);
});
