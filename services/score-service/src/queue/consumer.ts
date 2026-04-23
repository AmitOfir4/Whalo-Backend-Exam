import amqplib from 'amqplib';
import mongoose from 'mongoose';
import {
  getRedis,
  PLAYER_EVENTS_QUEUE,
  LEADERBOARD_KEY,
  PLAYERS_KNOWN_KEY,
  TOP_SCORES_SET,
  TOP_SCORES_DATA,
  onShutdown,
} from '@whalo/shared';

const QUEUE_NAME = PLAYER_EVENTS_QUEUE;

export async function startPlayerEventsConsumer(url: string): Promise<void>
{
  const connection = await amqplib.connect(url);
  const channel = await connection.createChannel();

  // On unexpected connection loss, exit so the orchestrator restarts us. The
  // alternative — reconnect in-process — would require re-plumbing ack/nack
  // handles through every in-flight message. Crash-and-restart is simpler
  // and safe: unacked messages are redelivered by the broker.
  connection.on('error', (err) =>
  {
    console.error('RabbitMQ connection error (score-service consumer):', err.message);
  });
  connection.on('close', () =>
  {
    console.error('RabbitMQ connection closed unexpectedly — exiting so the orchestrator restarts the service');
    process.exit(1);
  });

  await channel.assertQueue(QUEUE_NAME, { durable: true });
  await channel.prefetch(10);

  console.log('Score service consuming from player_events queue');

  let activeMessages = 0;
  let drainResolve: (() => void) | null = null;

  type EventHandler = (data: any) => Promise<void>;

  const handlers: Record<string, EventHandler> =
  {
    'player.created': async ({ playerId }) =>
    {
      // Seed playerscores totals and record the player as known in Redis —
      // both idempotent (upsert + SADD). Score-service no longer tracks
      // usernames: display names live exclusively in player-service and
      // are resolved client-side via GET /players/:playerId when needed.
      await Promise.all([
        mongoose.connection.db!.collection('playerscores').updateOne(
          { playerId },
          { $setOnInsert: { playerId, totalScore: 0, gamesPlayed: 0 } },
          { upsert: true }
        ),
        getRedis().sadd(PLAYERS_KNOWN_KEY, playerId),
      ]);

      console.log(`Initialized data for new player: ${playerId}`);
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
        redis.srem(PLAYERS_KNOWN_KEY, playerId),
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

  onShutdown(async () =>
  {
    console.log('Score service player_events consumer shutting down...');
    try
    {
      await channel.cancel(consumerTag);
    }
    catch (err)
    {
      console.error('Error cancelling consumer:', (err as Error).message);
    }
    if (activeMessages > 0)
    {
      await new Promise<void>((resolve) =>
      {
        drainResolve = resolve;
      });
    }
    try { await channel.close(); } catch { /* already closed */ }
    try { await connection.close(); } catch { /* already closed */ }
  });
}
