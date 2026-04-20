import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';

export async function getLeaderboard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const scoresCollection = mongoose.connection.db!.collection('scores');

    const [results, countResult] = await Promise.all([
      scoresCollection
        .aggregate([
          {
            $group: {
              _id: '$playerId',
              totalScore: { $sum: '$score' },
              gamesPlayed: { $sum: 1 },
            },
          },
          { $sort: { totalScore: -1 } },
          { $skip: skip },
          { $limit: limit },
          {
            $lookup: {
              from: 'players',
              localField: '_id',
              foreignField: 'playerId',
              as: 'player',
            },
          },
          { $unwind: { path: '$player', preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 0,
              playerId: '$_id',
              username: { $ifNull: ['$player.username', 'Unknown'] },
              totalScore: 1,
              gamesPlayed: 1,
            },
          },
        ])
        .toArray(),
      scoresCollection
        .aggregate([
          { $group: { _id: '$playerId' } },
          { $count: 'total' },
        ])
        .toArray(),
    ]);

    const totalPlayers = countResult[0]?.total || 0;
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
