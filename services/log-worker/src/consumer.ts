import amqplib, { ConsumeMessage } from 'amqplib';
import { Batcher, BatcherConfig } from './strategies/batcher';
import { LOGS_QUEUE } from '@whalo/shared';

const QUEUE_NAME = LOGS_QUEUE;

export async function startConsumer(
  url: string,
  config: BatcherConfig
): Promise<void> {
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, { durable: true });

  // Prefetch controls how many unacknowledged messages the worker holds
  await channel.prefetch(config.batchSize * 2);

  const batcher = new Batcher(config, (msg: ConsumeMessage) => {
    channel.ack(msg);
  });

  console.log(`Worker consuming from queue: ${QUEUE_NAME}`);
  console.log(`Batch size: ${config.batchSize}, interval: ${config.batchIntervalMs}ms`);
  console.log(`Max concurrent writes: ${config.maxConcurrentWrites}`);
  console.log(`Token bucket: capacity=${config.tokenBucketCapacity}, refill=${config.tokenBucketRefillRate}/s`);

  channel.consume(QUEUE_NAME, (msg) => {
    if (!msg) return;

    try {
      const data = JSON.parse(msg.content.toString());
      batcher.add(data, msg);
    } catch (error) {
      console.error('Failed to parse message:', error);
      // Reject malformed messages without requeue
      channel.nack(msg, false, false);
    }
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down worker...');
    await channel.close();
    await connection.close();
    process.exit(0);
  });
}
