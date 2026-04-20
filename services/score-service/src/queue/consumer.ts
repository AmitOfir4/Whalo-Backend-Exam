import amqplib from 'amqplib';
import mongoose from 'mongoose';
import { getRedis, PLAYER_EVENTS_QUEUE, LEADERBOARD_KEY, USERNAMES_KEY, TOP10_CACHE_KEY } from '@whalo/shared';

const QUEUE_NAME = PLAYER_EVENTS_QUEUE;

export async function startPlayerEventsConsumer(url: string): Promise<void> {
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.prefetch(10);

  console.log('Score service consuming from player_events queue');

  channel.consume(QUEUE_NAME, async (msg) => {
    if (!msg) return;

    try {
      const data = JSON.parse(msg.content.toString());

      if (data.event === 'player.deleted' && data.playerId) {
        const { playerId } = data;
        const redis = getRedis();

        // Remove from MongoDB playerscores, MongoDB scores, Redis sorted set,
        // Redis usernames hash, and invalidate top-10 cache — all in parallel
        await Promise.all([
          mongoose.connection.db!.collection('playerscores').deleteOne({ playerId }),
          mongoose.connection.db!.collection('scores').deleteMany({ playerId }),
          redis.zrem(LEADERBOARD_KEY, playerId),
          redis.hdel(USERNAMES_KEY, playerId),
          redis.del(TOP10_CACHE_KEY),
        ]);

        console.log(`Cleaned up data for deleted player: ${playerId}`);
      } else {
        console.warn(`Unknown player event: ${data.event}`);
      }

      channel.ack(msg);
    } catch (error) {
      console.error('Failed to process player event:', error);
      // Requeue on failure so the message is not lost
      channel.nack(msg, false, true);
    }
  });

  process.on('SIGINT', async () => {
    await channel.close();
    await connection.close();
  });
}
