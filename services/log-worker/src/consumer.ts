import amqplib, { ConsumeMessage } from 'amqplib';
import { Batcher, BatcherConfig } from './strategies/batcher';
import { LOGS_QUEUE, QUEUE_MAX_PRIORITY, onShutdown } from '@whalo/shared';

const QUEUE_NAME = LOGS_QUEUE;

export async function startConsumer(
  url: string,
  config: BatcherConfig
): Promise<void>
{
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  // Surface lost broker connection as a non-zero exit — the container
  // orchestrator will restart the worker, which will re-establish the
  // channel and re-register the consumer cleanly. Handling reconnect
  // in-process would require plumbing fresh ack/nack callbacks into every
  // buffered message; crash-and-restart is simpler and equally safe
  // because unacked messages are redelivered by the broker.
  connection.on('error', (err) =>
  {
    console.error('RabbitMQ connection error (log-worker):', err.message);
  });
  connection.on('close', () =>
  {
    console.error('RabbitMQ connection closed unexpectedly — exiting so the orchestrator restarts the worker');
    process.exit(1);
  });

  await channel.assertQueue(QUEUE_NAME, {
    durable: true,
    arguments: { 'x-max-priority': QUEUE_MAX_PRIORITY },
  });

  // Prefetch controls how many unacknowledged messages the worker holds
  await channel.prefetch(config.batchSize * 2);

  const batcher = new Batcher(
    config,
    (msg: ConsumeMessage) => channel.ack(msg),
    (msg: ConsumeMessage, requeue: boolean) => channel.nack(msg, false, requeue),
  );

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
      // Reject malformed messages without requeue — redelivering a message
      // we can't parse would just loop forever.
      channel.nack(msg, false, false);
    }
  });

  // Graceful shutdown — cancel the consumer, flush in-flight batches, close.
  onShutdown(async () =>
  {
    console.log('Log worker shutting down...');
    try
    {
      await channel.cancel(consumerTag);
    }
    catch (err)
    {
      console.error('Error cancelling consumer:', (err as Error).message);
    }
    await batcher.shutdown();
    try { await channel.close(); } catch { /* already closed */ }
    try { await connection.close(); } catch { /* already closed */ }
  });
}
