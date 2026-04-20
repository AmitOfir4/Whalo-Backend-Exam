import { Request, Response, NextFunction } from 'express';
import { Player } from '../models/player.model';
import { AppError } from '@whalo/shared';
import mongoose from 'mongoose';

export async function createPlayer(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { username, email } = req.body;

    const existingPlayer = await Player.findOne({ $or: [{ email }, { username }] });
    if (existingPlayer) {
      if (existingPlayer.email === email) {
        throw new AppError('A player with this email already exists', 409);
      }
      if (existingPlayer.username === username) {
        throw new AppError('A player with this username already exists', 409);
      }
    }

    const player = await Player.create({ username, email });

    // Seed an entry in playerscores so the player appears on the lerboard immediately
    await mongoose.connection.db!.collection('playerscores').insertOne({
      playerId: player.playerId,
      username: player.username,
      totalScore: 0,
      gamesPlayed: 0,
    });

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

export async function getAllPlayers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const players = await Player.find();
    res.json(players.map(player => player.toJSON()));
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

    if (updateData.email) {
      const existingPlayer = await Player.findOne({ email: updateData.email, playerId: { $ne: playerId } });
      if (existingPlayer) {
        throw new AppError('A player with this email already exists', 409);
      }
    }

    if (updateData.username) {
      const existingPlayer = await Player.findOne({ username: updateData.username, playerId: { $ne: playerId } });
      if (existingPlayer) {
        throw new AppError('A player with this username already exists', 409);
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
