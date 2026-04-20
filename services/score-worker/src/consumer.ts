import amqplib from 'amqplib';
import mongoose from 'mongoose';
import { getRedis, SCORE_EVENTS_QUEUE, LEADERBOARD_KEY, TOP10_CACHE_KEY } from '@whalo/shared';

const QUEUE_NAME = SCORE_EVENTS_QUEUE;

export async function startConsumer(url: string): Promise<void> {
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.prefetch(20);

  console.log(`Score worker consuming from queue: ${QUEUE_NAME}`);

  channel.consume(QUEUE_NAME, async (msg) => {
    if (!msg) return;

    try {
      const data = JSON.parse(msg.content.toString());

      if (data.event === 'score.submitted' && data.playerId && data.score != null) {
        const { playerId, username, score } = data;
        const redis = getRedis();

        // Update aggregated totals, leaderboard ranking, and invalidate cache — all in parallel
        await Promise.all([
          mongoose.connection.db!.collection('playerscores').updateOne(
            { playerId },
            { $inc: { totalScore: score, gamesPlayed: 1 }, $setOnInsert: { username } },
            { upsert: true }
          ),
          redis.zincrby(LEADERBOARD_KEY, score, playerId),
          redis.del(TOP10_CACHE_KEY),
        ]);

        console.log(`Processed score for player ${playerId}: +${score}`);
      } else {
        console.warn(`Unknown score event: ${data.event}`);
      }

      channel.ack(msg);
    } catch (error) {
      console.error('Failed to process score event:', error);
      channel.nack(msg, false, true);
    }
  });

  process.on('SIGINT', async () => {
    await channel.close();
    await connection.close();
  });
}
