import amqplib from 'amqplib';
import { SCORE_EVENTS_QUEUE } from '@whalo/shared';

const QUEUE_NAME = SCORE_EVENTS_QUEUE;

let connection: Awaited<ReturnType<typeof amqplib.connect>> | null = null;
let channel: Awaited<ReturnType<Awaited<ReturnType<typeof amqplib.connect>>['createChannel']>> | null = null;

export async function connectScoreQueue(url: string): Promise<void>
{
  connection = await amqplib.connect(url);
  channel = await connection.createChannel();
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  console.log('Score service publisher connected to RabbitMQ');
}

export async function publishScoreEvent(message: object): Promise<boolean>
{
  if (!channel)
  {
    throw new Error('RabbitMQ channel not initialized');
  }
  return channel.sendToQueue(
    QUEUE_NAME,
    Buffer.from(JSON.stringify(message)),
    { persistent: true }
  );
}

export async function closeScoreQueue(): Promise<void>
{
  if (channel)
  {
    await channel.close();
  }
  if (connection)
  {
    await connection.close();
  }
}
