import amqplib, { ConsumeMessage } from 'amqplib';
import { SCORE_EVENTS_QUEUE } from '@whalo/shared';
import { Batcher, BatcherConfig } from './strategies/batcher';

const QUEUE_NAME = SCORE_EVENTS_QUEUE;

export async function startConsumer(url: string, config: BatcherConfig): Promise<void>
{
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.prefetch(config.batchSize * 2);

  const batcher = new Batcher(
    config,
    (msg: ConsumeMessage) => channel.ack(msg),
    (msg: ConsumeMessage) => channel.nack(msg, false, true),
  );

  console.log(`Score worker consuming from queue: ${QUEUE_NAME}`);
  console.log(`Batch size: ${config.batchSize}, interval: ${config.batchIntervalMs}ms`);
  console.log(`Max concurrent writes: ${config.maxConcurrentWrites}`);

  type EventHandler = (data: any, msg: ConsumeMessage) => void;

  const handlers: Record<string, EventHandler> =
  {
    'score.submitted': (data, msg) =>
    {
      batcher.add(
        {
          playerId: data.playerId,
          username: data.username,
          score: data.score,
          timestamp: data.timestamp ?? Date.now(),
        },
        msg,
      );
    },
  };

  const { consumerTag } = await channel.consume(QUEUE_NAME, (msg) =>
  {
    if (!msg)
    {
      return;
    }

    try
    {
      const data = JSON.parse(msg.content.toString());
      const handler = handlers[data.event];

      if (handler)
      {
        handler(data, msg);
      }
      else
      {
        console.warn(`Unknown score event: ${data.event}`);
        // Reject unrecognised events without requeue — they will never be valid
        channel.nack(msg, false, false);
      }
    }
    catch (error)
    {
      console.error('Failed to parse score message:', error);
      channel.nack(msg, false, false);
    }
  });

  async function gracefulShutdown(): Promise<void>
  {
    console.log('Score worker shutting down...');
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
