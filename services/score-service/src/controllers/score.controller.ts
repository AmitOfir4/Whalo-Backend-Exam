import { Request, Response, NextFunction } from 'express';
import { Score } from '../models/score.model';
import { AppError, getRedis, USERNAMES_KEY, TOP10_CACHE_KEY } from '@whalo/shared';
import mongoose from 'mongoose';
import { publishScoreEvent } from '../queue/publisher';

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

    // Persist the score synchronously, offload aggregation + ranking to the score-worker
    const newScore = await Score.create({ playerId, username, score });

    await publishScoreEvent({ event: 'score.submitted', playerId, username, score });

    res.status(202).json(newScore.toJSON());
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
