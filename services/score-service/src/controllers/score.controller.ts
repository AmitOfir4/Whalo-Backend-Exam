import { Request, Response, NextFunction } from 'express';
import { Score } from '../models/score.model';
import { PlayerScore } from '../models/player-score.model';
import { AppError, getRedis, LEADERBOARD_KEY, USERNAMES_KEY, TOP10_CACHE_KEY } from '@whalo/shared';
import mongoose from 'mongoose';

const TOP10_TTL = 10; // seconds

export async function submitScore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId, score } = req.body;
    const redis = getRedis();

    // Check player existence: Redis cache first, then MongoDB fallback
    let username = await redis.hget(USERNAMES_KEY, playerId);

    if (!username) {
      const player = await mongoose.connection.db!.collection('players').findOne(
        { playerId },
        { projection: { _id: 0, username: 1 } }
      );
      if (!player) {
        throw new AppError('Player not found', 404);
      }
      username = player.username;
      // Cache the username for future lookups
      await redis.hset(USERNAMES_KEY, playerId, username!);
    }

    // Insert score, update aggregated totals, and update Redis sorted set in parallel
    const [newScore] = await Promise.all([
      Score.create({ playerId, username, score }),
      PlayerScore.updateOne(
        { playerId },
        { $inc: { totalScore: score, gamesPlayed: 1 }, $setOnInsert: { username } },
        { upsert: true }
      ),
      redis.zincrby(LEADERBOARD_KEY, score, playerId),
      redis.del(TOP10_CACHE_KEY), // invalidate top-10 cache
    ]);

    res.status(201).json(newScore.toJSON());
  } catch (error) {
    next(error);
  }
}

export async function getTopScores(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const redis = getRedis();

    // Try Redis cache first
    const cached = await redis.get(TOP10_CACHE_KEY);
    if (cached) {
      res.json(JSON.parse(cached));
      return;
    }

    // Cache miss — query MongoDB (no $lookup needed, username is denormalized)
    const topScores = await Score.find({}, { _id: 0, playerId: 1, username: 1, score: 1, createdAt: 1 })
      .sort({ score: -1 })
      .limit(10)
      .lean();

    // Cache result with short TTL
    await redis.set(TOP10_CACHE_KEY, JSON.stringify(topScores), 'EX', TOP10_TTL);

    res.json(topScores);
  } catch (error) {
    next(error);
  }
}
