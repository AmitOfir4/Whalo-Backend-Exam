import dotenv from 'dotenv';
import { connectDB } from '@whalo/shared';
import { startConsumer } from './consumer';
import { BatcherConfig } from './strategies/batcher';

dotenv.config({ path: '../../.env' });

const MONGO_URI = process.env.MONGO_URI || '';
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';

const config: BatcherConfig = {
  batchSize: Number(process.env.BATCH_SIZE) || 50,
  batchIntervalMs: Number(process.env.BATCH_INTERVAL_MS) || 2000,
  maxConcurrentWrites: Number(process.env.MAX_CONCURRENT_WRITES) || 3,
  tokenBucketCapacity: Number(process.env.TOKEN_BUCKET_CAPACITY) || 10,
  tokenBucketRefillRate: Number(process.env.TOKEN_BUCKET_REFILL_RATE) || 5,
};

async function start(): Promise<void> {
  await connectDB(MONGO_URI);
  await startConsumer(RABBITMQ_URL, config);
  console.log('Log Worker is running');
}

start().catch((error) => {
  console.error('Worker failed to start:', error);
  process.exit(1);
});
