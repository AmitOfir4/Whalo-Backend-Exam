import amqplib from 'amqplib';
import mongoose from 'mongoose';
import { getRedis, SCORE_EVENTS_QUEUE, LEADERBOARD_KEY, TOP_SCORES_SET, TOP_SCORES_DATA } from '@whalo/shared';

const QUEUE_NAME = SCORE_EVENTS_QUEUE;

export async function startConsumer(url: string): Promise<void>
{
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.prefetch(20);

  console.log(`Score worker consuming from queue: ${QUEUE_NAME}`);

  let inFlight = 0;
  let drainResolve: (() => void) | null = null;

  const { consumerTag } = await channel.consume(QUEUE_NAME, async (msg) =>
  {
    if (!msg)
    {
      return;
    }

    inFlight++;
    try
    {
      const data = JSON.parse(msg.content.toString());

      if (data.event === 'score.submitted' && data.playerId && data.score != null)
      {
        const { playerId, username, score, timestamp: eventTimestamp } = data;
        const redis = getRedis();
        // Use the timestamp from the HTTP path so both sides resolve to the
        // same scoreKey — the Lua script below is then idempotent.
        const timestamp = eventTimestamp ?? Date.now();
        const scoreKey = `${playerId}:${timestamp}`;

        // Prepare metadata for the top scores hash
        const metadata = JSON.stringify(
        {
          playerId,
          username,
          score,
          createdAt: new Date(timestamp).toISOString(),
        });

        // Update aggregated totals, persist individual score, leaderboard ranking, and top scores set — all in parallel
        await Promise.all([
          mongoose.connection.db!.collection('playerscores').updateOne(
            { playerId },
            { $inc: { totalScore: score, gamesPlayed: 1 }, $setOnInsert: { username } },
            { upsert: true }
          ),
          mongoose.connection.db!.collection('scores').insertOne(
            { playerId, username, score, createdAt: new Date(timestamp) }
          ),
          redis.zincrby(LEADERBOARD_KEY, score, playerId),
          // Maintain top 10 individual scores atomically via a Lua script.
          // Lua scripts execute as a single atomic operation on the Redis server,
          // preventing the TOCTOU race condition that occurs with prefetch > 1.
          redis.eval(
            `
            local setKey  = KEYS[1]
            local hashKey = KEYS[2]
            local score   = tonumber(ARGV[1])
            local member  = ARGV[2]
            local payload = ARGV[3]

            redis.call('ZADD', setKey, score, member)
            redis.call('HSET', hashKey, member, payload)

            local count = redis.call('ZCARD', setKey)
            if count > 10 then
              local evicted = redis.call('ZRANGE', setKey, 0, count - 11)
              redis.call('ZREMRANGEBYRANK', setKey, 0, count - 11)
              for _, k in ipairs(evicted) do
                redis.call('HDEL', hashKey, k)
              end
            end

            return 1
            `,
            2,
            TOP_SCORES_SET,
            TOP_SCORES_DATA,
            score,
            scoreKey,
            metadata,
          ),
        ]);

        console.log(`Processed score for player ${playerId}: +${score}`);
      }
      else
      {
        console.warn(`Unknown score event: ${data.event}`);
      }

      channel.ack(msg);
    }
    catch (error)
    {
      console.error('Failed to process score event:', error);
      channel.nack(msg, false, true);
    }
    finally
    {
      inFlight--;
      if (inFlight === 0 && drainResolve)
      {
        drainResolve();
        drainResolve = null;
      }
    }
  });

  async function gracefulShutdown(): Promise<void>
  {
    console.log('Score worker shutting down...');
    // Stop RabbitMQ from delivering new messages
    await channel.cancel(consumerTag);
    // Wait for all in-flight message handlers to finish
    if (inFlight > 0)
    {
      await new Promise<void>((resolve) =>
      {
        drainResolve = resolve;
      });
    }
    await channel.close();
    await connection.close();
    process.exit(0);
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}
