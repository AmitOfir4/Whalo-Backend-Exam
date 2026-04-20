import amqplib from 'amqplib';

const QUEUE_NAME = 'logs_queue';

let connection: Awaited<ReturnType<typeof amqplib.connect>> | null = null;
let channel: Awaited<ReturnType<Awaited<ReturnType<typeof amqplib.connect>>['createChannel']>> | null = null;

export async function connectQueue(url: string): Promise<void> {
  connection = await amqplib.connect(url);
  channel = await connection.createChannel();
  await channel.assertQueue(QUEUE_NAME, { durable: true });
  console.log('Connected to RabbitMQ');
}

export async function publishLog(message: object): Promise<boolean> {
  if (!channel) {
    throw new Error('RabbitMQ channel not initialized');
  }
  return channel.sendToQueue(
    QUEUE_NAME,
    Buffer.from(JSON.stringify(message)),
    { persistent: true }
  );
}

export async function closeQueue(): Promise<void> {
  if (channel) await channel.close();
  if (connection) await connection.close();
}
