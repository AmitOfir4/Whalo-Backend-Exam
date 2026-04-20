import amqplib from 'amqplib';
import { LOGS_QUEUE, LOG_PRIORITY_MAP, QUEUE_MAX_PRIORITY } from '@whalo/shared';
import type { LogPriority } from '@whalo/shared';

const QUEUE_NAME = LOGS_QUEUE;

let connection: Awaited<ReturnType<typeof amqplib.connect>> | null = null;
let channel: Awaited<ReturnType<Awaited<ReturnType<typeof amqplib.connect>>['createChannel']>> | null = null;

export async function connectQueue(url: string): Promise<void> {
  connection = await amqplib.connect(url);
  channel = await connection.createChannel();
  await channel.assertQueue(QUEUE_NAME, {
    durable: true,
    arguments: { 'x-max-priority': QUEUE_MAX_PRIORITY },
  });
  console.log('Connected to RabbitMQ');
}

export async function publishLog(message: object, priority: LogPriority = 'normal'): Promise<boolean> {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }
  return channel.sendToQueue(
    QUEUE_NAME,
    Buffer.from(JSON.stringify(message)),
    { persistent: true, priority: LOG_PRIORITY_MAP[priority] }
  );
}

export async function closeQueue(): Promise<void> {
  if (channel) await channel.close();
  if (connection) await connection.close();
}
