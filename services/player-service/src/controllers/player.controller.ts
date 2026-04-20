import { Request, Response, NextFunction } from 'express';
import { Player } from '../models/player.model';
import { AppError } from '@whalo/shared';

export async function createPlayer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username, email } = req.body;

    const existingPlayer = await Player.findOne({ email });
    if (existingPlayer) {
      throw new AppError('A player with this email already exists', 409);
    }

    const player = await Player.create({ username, email });
    res.status(201).json(player.toJSON());
  } catch (error) {
    next(error);
  }
}

export async function getPlayer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId } = req.params;
    const player = await Player.findOne({ playerId });

    if (!player) {
      throw new AppError('Player not found', 404);
    }

    res.json(player.toJSON());
  } catch (error) {
    next(error);
  }
}

export async function updatePlayer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId } = req.params;
    const updateData: Record<string, string> = {};

    if (req.body.username) updateData.username = req.body.username;
    if (req.body.email) updateData.email = req.body.email;

    if (req.body.email) {
      const existingPlayer = await Player.findOne({ email: req.body.email, playerId: { $ne: playerId } });
      if (existingPlayer) {
        throw new AppError('A player with this email already exists', 409);
      }
    }

    const player = await Player.findOneAndUpdate(
      { playerId },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!player) {
      throw new AppError('Player not found', 404);
    }

    res.json(player.toJSON());
  } catch (error) {
    next(error);
  }
}

export async function deletePlayer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId } = req.params;
    const player = await Player.findOneAndDelete({ playerId });

    if (!player) {
      throw new AppError('Player not found', 404);
    }

    res.json({ message: 'Player deleted successfully' });
  } catch (error) {
    next(error);
  }
}
