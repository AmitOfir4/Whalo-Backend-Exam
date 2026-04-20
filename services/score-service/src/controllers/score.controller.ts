import { Request, Response, NextFunction } from 'express';
import { Score } from '../models/score.model';
import { AppError } from '@whalo/shared';
import mongoose from 'mongoose';

export async function submitScore(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId, score } = req.body;

    // Verify the player exists in the players collection
    const playerExists = await mongoose.connection.db!.collection('players').findOne({ playerId });
    if (!playerExists) {
      throw new AppError('Player not found', 404);
    }

    const newScore = await Score.create({ playerId, score });
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
