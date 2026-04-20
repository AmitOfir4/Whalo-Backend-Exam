import amqplib, { ConsumeMessage } from 'amqplib';
import { Batcher, BatcherConfig } from './strategies/batcher';
import { LOGS_QUEUE, QUEUE_MAX_PRIORITY } from '@whalo/shared';

const QUEUE_NAME = LOGS_QUEUE;

export async function startConsumer(
  url: string,
  config: BatcherConfig
): Promise<void>
{
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, {
    durable: true,
    arguments: { 'x-max-priority': QUEUE_MAX_PRIORITY },
  });

  // Prefetch controls how many unacknowledged messages the worker holds
  await channel.prefetch(config.batchSize * 2);

  const batcher = new Batcher(config, (msg: ConsumeMessage) =>
  {
    channel.ack(msg);
  });

  console.log(`Worker consuming from queue: ${QUEUE_NAME}`);
  console.log(`Batch size: ${config.batchSize}, interval: ${config.batchIntervalMs}ms`);
  console.log(`Max concurrent writes: ${config.maxConcurrentWrites}`);
  console.log(`Token bucket: capacity=${config.tokenBucketCapacity}, refill=${config.tokenBucketRefillRate}/s`);

  const { consumerTag } = await channel.consume(QUEUE_NAME, (msg) =>
  {
    if (!msg)
    {
      return;
    }

    try
    {
      const data = JSON.parse(msg.content.toString());
      batcher.add(data, msg);
    }
    catch (error)
    {
      console.error('Failed to parse message:', error);
      // Reject malformed messages without requeue
      channel.nack(msg, false, false);
    }
  });

  // Graceful shutdown — flush buffered messages before closing
  async function gracefulShutdown(): Promise<void>
  {
    console.log('Log worker shutting down...');
    // Stop RabbitMQ from delivering new messages
    await channel.cancel(consumerTag);
    // Flush buffered messages and wait for all in-progress writes to finish
    await batcher.shutdown();
    await channel.close();
    await connection.close();
    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}
