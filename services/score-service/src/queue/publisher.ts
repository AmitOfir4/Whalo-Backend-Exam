import { SCORE_EVENTS_QUEUE, RabbitMQConnection } from '@whalo/shared';

const QUEUE_NAME = SCORE_EVENTS_QUEUE;

let rabbit: RabbitMQConnection | null = null;

export async function connectScoreQueue(url: string): Promise<void>
{
  rabbit = new RabbitMQConnection({ url });

  await rabbit.onReady(async (channel) =>
  {
    await channel.assertQueue(QUEUE_NAME, { durable: true });
  });

  await rabbit.connect();
  console.log('Score service publisher connected to RabbitMQ');
}

export async function publishScoreEvent(message: object): Promise<void>
{
  if (!rabbit)
  {
    throw new Error('RabbitMQ publisher not initialized');
  }
  await rabbit.publish(
    QUEUE_NAME,
    Buffer.from(JSON.stringify(message)),
    { persistent: true },
  );
}

export async function closeScoreQueue(): Promise<void>
{
  if (rabbit)
  {
    await rabbit.close();
    rabbit = null;
  }
}
