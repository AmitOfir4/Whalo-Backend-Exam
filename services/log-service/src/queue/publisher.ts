import { LOGS_QUEUE, LOG_PRIORITY_MAP, QUEUE_MAX_PRIORITY, RabbitMQConnection } from '@whalo/shared';
import type { LogPriority } from '@whalo/shared';

const QUEUE_NAME = LOGS_QUEUE;

let rabbit: RabbitMQConnection | null = null;

export async function connectQueue(url: string): Promise<void>
{
  rabbit = new RabbitMQConnection({ url });

  await rabbit.onReady(async (channel) =>
  {
    await channel.assertQueue(QUEUE_NAME, {
      durable: true,
      arguments: { 'x-max-priority': QUEUE_MAX_PRIORITY },
    });
  });

  await rabbit.connect();
  console.log('Log service publisher connected to RabbitMQ');
}

export async function publishLog(message: object, priority: LogPriority = 'normal'): Promise<void>
{
  if (!rabbit)
  {
    throw new Error('RabbitMQ publisher not initialized');
  }
  await rabbit.publish(
    QUEUE_NAME,
    Buffer.from(JSON.stringify(message)),
    { persistent: true, priority: LOG_PRIORITY_MAP[priority] },
  );
}

export async function closeQueue(): Promise<void>
{
  if (rabbit)
  {
    await rabbit.close();
    rabbit = null;
  }
}
