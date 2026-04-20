import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';

export async function getLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const playerScoresCollection = mongoose.connection.db!.collection('playerscores');

    const [results, totalPlayers] = await Promise.all([
      playerScoresCollection
        .aggregate([
          { $sort: { totalScore: -1 } },
          { $skip: skip },
          { $limit: limit },
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
              totalScore: 1,
              gamesPlayed: 1,
            },
          },
        ])
        .toArray(),
      playerScoresCollection.countDocuments(),
    ]);

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
  } catch (error) {
    next(error);
  }
}
