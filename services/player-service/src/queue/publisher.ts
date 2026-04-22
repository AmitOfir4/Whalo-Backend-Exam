import { PLAYER_EVENTS_QUEUE, RabbitMQConnection } from '@whalo/shared';

const QUEUE_NAME = PLAYER_EVENTS_QUEUE;

let rabbit: RabbitMQConnection | null = null;

export async function connectQueue(url: string): Promise<void>
{
  rabbit = new RabbitMQConnection({ url });

  // Hook runs on initial connect and every reconnect so the queue topology
  // is re-declared on a fresh channel after a broker blip.
  await rabbit.onReady(async (channel) =>
  {
    await channel.assertQueue(QUEUE_NAME, { durable: true });
  });

  await rabbit.connect();
  console.log('Player service publisher connected to RabbitMQ');
}

export async function publishPlayerEvent(message: object): Promise<void>
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

export async function closeQueue(): Promise<void>
{
  if (rabbit)
  {
    await rabbit.close();
    rabbit = null;
  }
}
