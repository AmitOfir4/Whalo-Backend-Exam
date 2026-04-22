import { Request, Response, NextFunction } from 'express';
import { Score } from '../models/score.model';
import {
  AppError,
  getRedis,
  USERNAMES_KEY,
  TOP_SCORES_SET,
  TOP_SCORES_DATA,
  withDistributedLock,
} from '@whalo/shared';
import mongoose from 'mongoose';
import { publishScoreEvent } from '../queue/publisher';

const TOP_SCORES_HYDRATE_LOCK_KEY = 'top-scores:hydrate:lock';
const TOP_SCORES_HYDRATE_LOCK_TTL_MS = 30_000;
const TOP_SCORES_HYDRATE_LOCK_WAIT_MS = 300;

export async function submitScore(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const { playerId, score } = req.body;
    const redis = getRedis();

    // Check player existence: Redis cache first, then MongoDB fallback
    let username = await redis.hget(USERNAMES_KEY, playerId);

    if (!username)
    {
      const player = await mongoose.connection.db!.collection('players').findOne(
        { playerId },
        { projection: { _id: 0, username: 1 } }
      );
      if (!player)
      {
        throw new AppError('Player not found', 404);
      }
      username = player.username;
      // Cache the username for future lookups
      await redis.hset(USERNAMES_KEY, playerId, username!);
    }

    // Generate the timestamp here so both the HTTP path and the worker share
    // the same scoreKey — avoiding duplicate entries in the sorted set.
    const timestamp = Date.now();
    const scoreKey = `${playerId}:${timestamp}`;
    const metadata = JSON.stringify(
    {
      playerId,
      username,
      score,
      createdAt: new Date(timestamp).toISOString(),
    });

    // Publish the event — score persistence and leaderboard aggregation are
    // handled entirely by the score-worker, keeping the HTTP path non-blocking.
    await publishScoreEvent({ event: 'score.submitted', playerId, username: username!, score, timestamp });

    // Immediately update the top-scores sorted set so the leaderboard reflects
    // this score right now — without waiting for the worker to drain the queue.
    // The worker will run the same Lua script on the same scoreKey, which is
    // idempotent (ZADD/HSET are no-ops for identical member+score pairs).
    await redis.eval(
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
        for _, k in ipairs(evicted) do redis.call('HDEL', hashKey, k) end
      end

      return 1
      `,
      2,
      TOP_SCORES_SET,
      TOP_SCORES_DATA,
      score,
      scoreKey,
      metadata,
    );

    res.status(202).json({ playerId, username, score });
  }
  catch (error)
  {
    next(error);
  }
}

export async function getTopScores(_req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const redis = getRedis();

    // Read top 10 keys from Redis sorted set (O(log N) — no MongoDB, no cache stampede)
    const topKeys = await redis.zrevrange(TOP_SCORES_SET, 0, 9);

    if (topKeys.length === 0)
    {
      res.json([]);
      return;
    }

    // Fetch metadata for each key from the hash
    const rawData = await redis.hmget(TOP_SCORES_DATA, ...topKeys);

    const topScores = rawData
      .filter((item): item is string => item !== null)
      .map((item) => JSON.parse(item));

    res.json(topScores);
  }
  catch (error)
  {
    next(error);
  }
}

/**
 * Cold-start hydration: populate the top scores sorted set from MongoDB if
 * Redis is empty (e.g., after a Redis restart).
 *
 * Wrapped in a distributed lock (mirroring the leaderboard-service pattern)
 * so that when N replicas cold-start together, only one performs the
 * MongoDB read + pipeline load. The others wait briefly and return — the
 * next request will hit the already-populated fast path.
 */
export async function hydrateTopScoresFromMongo(): Promise<void>
{
  const redis = getRedis();

  // Fast path — sorted set already populated
  const count = await redis.zcard(TOP_SCORES_SET);
  if (count > 0)
  {
    console.log(`Top scores set already populated (${count} entries), skipping hydration.`);
    return;
  }

  await withDistributedLock(
    redis,
    {
      key: TOP_SCORES_HYDRATE_LOCK_KEY,
      ttlMs: TOP_SCORES_HYDRATE_LOCK_TTL_MS,
      waitOnContendedMs: TOP_SCORES_HYDRATE_LOCK_WAIT_MS,
    },
    async () =>
    {
      // Re-check inside the lock in case another replica just finished
      const sizeAfterLock = await redis.zcard(TOP_SCORES_SET);
      if (sizeAfterLock > 0)
      {
        return;
      }

      console.log('Hydrating top scores from MongoDB...');

      const topScores = await Score.find({}, { _id: 0, playerId: 1, username: 1, score: 1, createdAt: 1 })
        .sort({ score: -1 })
        .limit(10)
        .lean();

      if (topScores.length === 0)
      {
        console.log('No scores in MongoDB, skipping hydration.');
        return;
      }

      const pipeline = redis.pipeline();

      for (const entry of topScores)
      {
        const timestamp = new Date(entry.createdAt).getTime();
        const scoreKey = `${entry.playerId}:${timestamp}`;
        const metadata = JSON.stringify(
        {
          playerId: entry.playerId,
          username: entry.username,
          score: entry.score,
          createdAt: entry.createdAt,
        });

        pipeline.zadd(TOP_SCORES_SET, entry.score, scoreKey);
        pipeline.hset(TOP_SCORES_DATA, scoreKey, metadata);
      }

      await pipeline.exec();
      console.log(`Hydrated ${topScores.length} top scores into Redis.`);
    },
  );
}
