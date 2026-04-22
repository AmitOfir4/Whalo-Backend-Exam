import { Request, Response, NextFunction } from 'express';
import { Score } from '../models/score.model';
import {
  AppError,
  getRedis,
  PLAYERS_KNOWN_KEY,
  TOP_SCORES_SET,
  TOP_SCORES_DATA,
  withDistributedLock,
  evalIdempotentLeaderboardIncrement,
  resolveLeaderboardAppliedTtlSeconds,
} from '@whalo/shared';
import mongoose from 'mongoose';
import { publishScoreEvent } from '../queue/publisher';

const TOP_SCORES_HYDRATE_LOCK_KEY = 'top-scores:hydrate:lock';
const TOP_SCORES_HYDRATE_LOCK_TTL_MS = 30_000;
const TOP_SCORES_HYDRATE_LOCK_WAIT_MS = 300;

const KNOWN_PLAYERS_HYDRATE_LOCK_KEY = 'players-known:hydrate:lock';
const KNOWN_PLAYERS_HYDRATE_LOCK_TTL_MS = 30_000;
const KNOWN_PLAYERS_HYDRATE_LOCK_WAIT_MS = 300;

export async function submitScore(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const { playerId, score } = req.body;
    const redis = getRedis();

    await ensureKnownPlayersPopulated();
    const isKnown = await redis.sismember(PLAYERS_KNOWN_KEY, playerId);
    if (!isKnown)
    {
      throw new AppError('Player not found', 404);
    }

    // Generate the timestamp here so both the HTTP path and the worker share
    // the same scoreKey — avoiding duplicate entries in the sorted set.
    const timestamp = Date.now();
    const scoreKey = `${playerId}:${timestamp}`;
    const metadata = JSON.stringify(
    {
      playerId,
      score,
      createdAt: new Date(timestamp).toISOString(),
    });

    // Publish the event — durable score persistence (insertMany into scores
    // + $inc on playerscores) is still handled by the score-worker, keeping
    // the HTTP path non-blocking.
    await publishScoreEvent({ event: 'score.submitted', playerId, score, timestamp });

    // Update both Redis read paths synchronously so the client sees its
    // submission reflected immediately — without waiting for the worker to
    // drain the score_events queue. Both scripts are idempotent on the same
    // scoreKey (`playerId:timestamp`), so when the worker later runs them
    // on the same message they are safe no-ops:
    //   - Top-10: ZADD / HSET for an identical member+score pair is a no-op.
    //   - Leaderboard: the SET NX applied-marker gates the ZINCRBY, so the
    //     second call (whichever path runs second) never double-increments.
    // Running in parallel so the HTTP latency isn't serialised across both.
    const ttlSeconds = resolveLeaderboardAppliedTtlSeconds();
    await Promise.all([
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
      ),
      evalIdempotentLeaderboardIncrement(redis, { playerId, score, scoreKey, ttlSeconds }),
    ]);

    res.status(202).json({ playerId, score });
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

    // Fetch the immutable score metadata for each key from the hash. Clients
    // resolve display names via GET /players?ids=... against player-service.
    const rawData = await redis.hmget(TOP_SCORES_DATA, ...topKeys);

    const topScores = rawData
      .filter((item): item is string => item !== null)
      .map((item) => JSON.parse(item) as { playerId: string; score: number; createdAt: string });

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

      const topScores = await Score.find({}, { _id: 0, playerId: 1, score: 1, createdAt: 1 })
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

/**
 * Cold-start hydration: populate the `players:known` Redis SET from the
 * playerscores collection if it is empty. playerscores is owned by this
 * service and contains a row for every player score-service has ever
 * observed (upserted on the first `player.created` event), so it is the
 * correct boundary-respecting source for this set. Under steady state
 * the set is maintained incrementally by the player_events consumer;
 * this function only matters after a Redis flush / cold start.
 */
export async function ensureKnownPlayersPopulated(): Promise<void>
{
  const redis = getRedis();

  // Fast path — set already populated
  const size = await redis.scard(PLAYERS_KNOWN_KEY);
  if (size > 0)
  {
    return;
  }

  await withDistributedLock(
    redis,
    {
      key: KNOWN_PLAYERS_HYDRATE_LOCK_KEY,
      ttlMs: KNOWN_PLAYERS_HYDRATE_LOCK_TTL_MS,
      waitOnContendedMs: KNOWN_PLAYERS_HYDRATE_LOCK_WAIT_MS,
    },
    async () =>
    {
      const sizeAfterLock = await redis.scard(PLAYERS_KNOWN_KEY);
      if (sizeAfterLock > 0)
      {
        return;
      }

      const playerIds = await mongoose.connection.db!.collection('playerscores')
        .find({}, { projection: { _id: 0, playerId: 1 } })
        .toArray();

      if (playerIds.length === 0)
      {
        return;
      }

      // SADD is variadic + O(N) — one round-trip for the whole backfill.
      await redis.sadd(PLAYERS_KNOWN_KEY, ...playerIds.map((p) => p.playerId as string));
      console.log(`Hydrated ${playerIds.length} known players into Redis.`);
    },
  );
}
