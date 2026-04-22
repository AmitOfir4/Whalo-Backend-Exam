import amqplib from 'amqplib';
import mongoose from 'mongoose';
import { getRedis, PLAYER_EVENTS_QUEUE, LEADERBOARD_KEY, USERNAMES_KEY, TOP10_CACHE_KEY, TOP_SCORES_SET, TOP_SCORES_DATA } from '@whalo/shared';

const QUEUE_NAME = PLAYER_EVENTS_QUEUE;

export async function startPlayerEventsConsumer(url: string): Promise<void>
{
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.prefetch(10);

  console.log('Score service consuming from player_events queue');

  let activeMessages = 0;
  let drainResolve: (() => void) | null = null;

  type EventHandler = (data: any) => Promise<void>;

  const handlers: Record<string, EventHandler> =
  {
    'player.created': async ({ playerId, username }) =>
    {
      // Seed playerscores entry and cache username — idempotent via upsert
      await Promise.all([
        mongoose.connection.db!.collection('playerscores').updateOne(
          { playerId },
          { $setOnInsert: { playerId, username, totalScore: 0, gamesPlayed: 0 } },
          { upsert: true }
        ),
        getRedis().hset(USERNAMES_KEY, playerId, username),
      ]);

      console.log(`Initialized data for new player: ${playerId}`);
    },

    'player.username_updated': async ({ playerId, username }) =>
    {
      // Cascade username change to all denormalized locations
      await Promise.all([
        mongoose.connection.db!.collection('scores').updateMany({ playerId }, { $set: { username } }),
        mongoose.connection.db!.collection('playerscores').updateOne({ playerId }, { $set: { username } }),
        getRedis().hset(USERNAMES_KEY, playerId, username),
        getRedis().del(TOP10_CACHE_KEY),
      ]);

      console.log(`Updated username for player: ${playerId}`);
    },

    'player.deleted': async ({ playerId }) =>
    {
      const redis = getRedis();

      // Atomically remove all top-score entries for this player in a single
      // round-trip. The Lua script scans the (max 10-entry) sorted set,
      // removes matching `playerId:*` members from both the set and the hash.
      const removePlayerTopScores = redis.eval(
        `
        local members = redis.call('ZRANGE', KEYS[1], 0, -1)
        local prefix  = ARGV[1]
        for _, member in ipairs(members) do
          if string.sub(member, 1, #prefix) == prefix then
            redis.call('ZREM',  KEYS[1], member)
            redis.call('HDEL',  KEYS[2], member)
          end
        end
        return 1
        `,
        2,
        TOP_SCORES_SET,
        TOP_SCORES_DATA,
        `${playerId}:`,
      );

      await Promise.all([
        mongoose.connection.db!.collection('playerscores').deleteOne({ playerId }),
        mongoose.connection.db!.collection('scores').deleteMany({ playerId }),
        redis.zrem(LEADERBOARD_KEY, playerId),
        redis.hdel(USERNAMES_KEY, playerId),
        redis.del(TOP10_CACHE_KEY),
        removePlayerTopScores,
      ]);

      console.log(`Cleaned up data for deleted player: ${playerId}`);
    },
  };

  const { consumerTag } = await channel.consume(QUEUE_NAME, async (msg) =>
  {
    if (!msg)
    {
      return;
    }

    activeMessages++;
    try
    {
      const data = JSON.parse(msg.content.toString());
      const handler = handlers[data.event];

      if (handler)
      {
        await handler(data);
      }
      else
      {
        console.warn(`Unknown player event: ${data.event}`);
      }

      channel.ack(msg);
    }
    catch (error)
    {
      console.error('Failed to process player event:', error);
      // Requeue on failure so the message is not lost
      channel.nack(msg, false, true);
    }
    finally
    {
      activeMessages--;
      if (activeMessages === 0 && drainResolve)
      {
        drainResolve();
        drainResolve = null;
      }
    }
  });

  async function gracefulShutdown(): Promise<void>
  {
    console.log('Score service player_events consumer shutting down...');
    await channel.cancel(consumerTag);
    if (activeMessages > 0)
    {
      await new Promise<void>((resolve) =>
      {
        drainResolve = resolve;
      });
    }
    await channel.close();
    await connection.close();
  }

  process.on('SIGINT', gracefulShutdown);
  process.on('SIGTERM', gracefulShutdown);
}
