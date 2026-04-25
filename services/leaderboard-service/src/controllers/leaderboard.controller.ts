import { Request, Response, NextFunction } from 'express';
import { getRedis, LEADERBOARD_KEY, hydrateLeaderboardFromMongo } from '@whalo/shared';
import mongoose from 'mongoose';

export async function getLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const redis = getRedis();
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const start = (page - 1) * limit;
    const stop = start + limit - 1;

    // Defence-in-depth fallback: under steady state, hydration runs at startup
    // (see app.ts) so the sentinel is already set and this is a single EXISTS
    // round-trip. The lazy call here only does real work if Redis was flushed
    // mid-life, in which case the helper's lock + sentinel keep it correct.
    await hydrateLeaderboardFromMongo(redis, mongoose.connection);

    // ZREVRANGE returns top players by totalScore — O(log N + M)
    const leaderboardRaw = await redis.zrevrange(LEADERBOARD_KEY, start, stop, 'WITHSCORES');

    // Parse pairs: [playerId, score, playerId, score, ...] into entry objects.
    // Clients resolve display names by calling GET /players/:playerId on
    // player-service per row from this response (if they need names at all).
    const results: { playerId: string; totalScore: number }[] = [];
    for (let i = 0; i < leaderboardRaw.length; i += 2)
    {
      results.push({
        playerId: leaderboardRaw[i],
        totalScore: Number(leaderboardRaw[i + 1]),
      });
    }

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
