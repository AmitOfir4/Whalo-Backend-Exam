import { Request, Response, NextFunction } from 'express';
import { getRedis, LEADERBOARD_KEY, USERNAMES_KEY, withDistributedLock } from '@whalo/shared';
import mongoose from 'mongoose';

const BACKFILL_LOCK_KEY = 'leaderboard:backfill:lock';
const BACKFILL_LOCK_TTL_MS = 30_000;
const BACKFILL_LOCK_WAIT_MS = 300;

/**
 * Backfill the Redis sorted set from MongoDB when Redis is cold (empty).
 * Wrapped in a distributed lock so only one replica performs the expensive
 * MongoDB read; concurrent callers wait briefly and return, letting the
 * next request hit the already-populated fast path.
 */
async function ensureLeaderboardPopulated(): Promise<void>
{
  const redis = getRedis();

  // Fast path — sorted set already populated
  const size = await redis.zcard(LEADERBOARD_KEY);
  if (size > 0)
  {
    return;
  }

  await withDistributedLock(
    redis,
    { key: BACKFILL_LOCK_KEY, ttlMs: BACKFILL_LOCK_TTL_MS, waitOnContendedMs: BACKFILL_LOCK_WAIT_MS },
    async () =>
    {
      // Re-check inside the lock in case another replica just finished
      const sizeAfterLock = await redis.zcard(LEADERBOARD_KEY);
      if (sizeAfterLock > 0)
      {
        return;
      }

      const playerScoresCollection = mongoose.connection.db!.collection('playerscores');
      const allScores = await playerScoresCollection
        .find({}, { projection: { _id: 0, playerId: 1, username: 1, totalScore: 1 } })
        .toArray();

      if (allScores.length === 0)
      {
        return;
      }

      const pipeline = redis.pipeline();
      for (const doc of allScores)
      {
        pipeline.zadd(LEADERBOARD_KEY, doc.totalScore, doc.playerId);
        if (doc.username)
        {
          pipeline.hset(USERNAMES_KEY, doc.playerId, doc.username);
        }
      }
      await pipeline.exec();
    },
  );
}

export async function getLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const redis = getRedis();
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    // Ensure Redis is populated on cold start
    await ensureLeaderboardPopulated();

    // ZREVRANGE returns top players by totalScore — O(log N + M)
    const leaderboardRaw = await redis.zrevrange(LEADERBOARD_KEY, start, stop, 'WITHSCORES');

    // Parse pairs: [playerId, score, playerId, score, ...]
    const playerIds: string[] = [];
    const scores: number[] = [];
    for (let i = 0; i < leaderboardRaw.length; i += 2)
    {
      playerIds.push(leaderboardRaw[i]);
      scores.push(Number(leaderboardRaw[i + 1]));
    }

    // Batch-fetch usernames from Redis hash
    let usernames: (string | null)[] = [];
    if (playerIds.length > 0)
    {
      usernames = await redis.hmget(USERNAMES_KEY, ...playerIds);
    }

    const results = playerIds.map((playerId, i) => ({
      playerId,
      username: usernames[i] || 'Unknown',
      totalScore: scores[i],
    }));

    const totalPlayers = await redis.zcard(LEADERBOARD_KEY);
    const totalPages = Math.ceil(totalPlayers / limit);

    res.json({
      data: results,
      pagination: {
        page,
        limit,
        totalPlayers,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1,
      },
    });
  }
  catch (error)
  {
    next(error);
  }
}
