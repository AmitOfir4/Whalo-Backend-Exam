import { Request, Response, NextFunction } from 'express';
import { Player } from '../models/player.model';
import { AppError, throwConflictIfDuplicate } from '@whalo/shared';
import { publishPlayerEvent } from '../queue/publisher';
import type { ResolvePlayersQuery } from '../validators/player.validator';

// Translate Mongo E11000 duplicate-key errors on players to 409 Conflict
// with a meaningful, field-specific message.
const PLAYER_DUPLICATE_FIELD_MESSAGES: Record<string, string> =
{
  email: 'A player with this email already exists',
  username: 'A player with this username already exists',
  playerId: 'A player with this ID already exists',
};

export async function createPlayer(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const { username, email } = req.body;

    // We rely on Mongo's unique index as the authoritative uniqueness check.
    // A pre-check (findOne then insert) is vulnerable to a TOCTOU race: two
    // requests with the same email can both pass the check and both reach
    // the insert — producing an unhandled 11000 and a 500 response. Instead,
    // insert first and translate any E11000 to a clean 409.
    let player;
    try
    {
      player = await Player.create({ username, email });
    }
    catch (err)
    {
      throwConflictIfDuplicate(err, PLAYER_DUPLICATE_FIELD_MESSAGES);
    }

    // Publish event so score-service creates the playerscores entry asynchronously
    await publishPlayerEvent({ event: 'player.created', playerId: player!.playerId, username: player!.username });

    res.status(201).json(player!.toJSON());
  }
  catch (error)
  {
    next(error);
  }
}

export async function getPlayer(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const { playerId } = req.params;
    const player = await Player.findOne({ playerId });

    if (!player)
    {
      throw new AppError('Player not found', 404);
    }

    res.json(player.toJSON());
  }
  catch (error)
  {
    next(error);
  }
}

// Batch-resolve playerIds → usernames. The only read path on GET /players.
// Called by clients enriching leaderboard / top-scores rows with display
// names: one request per page, not N. Response preserves the caller's
// requested order so the caller doesn't need to re-zip with its own array;
// unknown ids are silently omitted (the caller can render them as "Unknown"
// or skip them).
export async function resolvePlayersByIds(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    // validateQuery has already parsed, deduped, and bounded this list.
    const { ids } = req.query as unknown as ResolvePlayersQuery;

    const players = await Player.find(
      { playerId: { $in: ids } },
      { _id: 0, playerId: 1, username: 1 },
    ).lean();

    const byId = new Map<string, { playerId: string; username: string }>(
      players.map((p) => [p.playerId, { playerId: p.playerId, username: p.username }]),
    );
    const ordered = ids
      .map((id) => byId.get(id))
      .filter((p): p is { playerId: string; username: string } => p !== undefined);

    res.json({ data: ordered });
  }
  catch (error)
  {
    next(error);
  }
}

export async function updatePlayer(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const { playerId } = req.params;
    const updateData: Record<string, string> = {};

    if (req.body.username) updateData.username = req.body.username;
    if (req.body.email) updateData.email = req.body.email;

    let player;
    try
    {
      player = await Player.findOneAndUpdate(
        { playerId },
        { $set: updateData },
        { new: true, runValidators: true },
      );
    }
    catch (err)
    {
      // Unique-index violation — someone else grabbed this email/username
      // between the client's request and our write. Translate to 409.
      throwConflictIfDuplicate(err, PLAYER_DUPLICATE_FIELD_MESSAGES);
    }

    if (!player)
    {
      throw new AppError('Player not found', 404);
    }

    // Propagate username change to score-service so denormalized data stays consistent
    if (updateData.username)
    {
      await publishPlayerEvent({ event: 'player.username_updated', playerId, username: updateData.username });
    }

    res.json(player.toJSON());
  }
  catch (error)
  {
    next(error);
  }
}

export async function deletePlayer(req: Request, res: Response, next: NextFunction): Promise<void>
{
  try
  {
    const { playerId } = req.params;
    const player = await Player.findOneAndDelete({ playerId });

    if (!player)
    {
      throw new AppError('Player not found', 404);
    }

    await publishPlayerEvent({ event: 'player.deleted', playerId });

    res.json({ message: 'Player deleted successfully' });
  }
  catch (error)
  {
    next(error);
  }
}
