import { Request, Response, NextFunction } from 'express';
import { Score } from '../models/score.model';
import { PlayerScore } from '../models/player-score.model';
import { AppError } from '@whalo/shared';
import mongoose from 'mongoose';

export async function submitScore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId, score } = req.body;

    // Verify the player exists — projection limits returned data to just _id
    const playerExists = await mongoose.connection.db!.collection('players').findOne(
      { playerId },
      { projection: { _id: 1 } }
    );
    if (!playerExists) {
      throw new AppError('Player not found', 404);
    }

    // Insert individual score and atomically update aggregated totals in parallel
    const [newScore] = await Promise.all([
      Score.create({ playerId, score }),
      PlayerScore.updateOne(
        { playerId },
        { $inc: { totalScore: score, gamesPlayed: 1 } },
        { upsert: true }
      ),
    ]);

    res.status(201).json(newScore.toJSON());
  } catch (error) {
    next(error);
  }
}

export async function getTopScores(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const topScores = await Score.aggregate([
      { $sort: { score: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'players',
          localField: 'playerId',
          foreignField: 'playerId',
          as: 'player',
        },
      },
      { $unwind: { path: '$player', preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          playerId: 1,
          username: { $ifNull: ['$player.username', 'Unknown'] },
          score: 1,
          createdAt: 1,
        },
      },
    ]);

    res.json(topScores);
  } catch (error) {
    next(error);
  }
}
