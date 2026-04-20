import { Request, Response, NextFunction } from 'express';
import { publishLog } from '../queue/publisher';

export async function createLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId, logData } = req.body;

    await publishLog({
      playerId,
      logData,
      receivedAt: new Date().toISOString(),
    });

    res.status(202).json({
      message: 'Log received and queued for processing',
    });
  } catch (error) {
    next(error);
  }
}
