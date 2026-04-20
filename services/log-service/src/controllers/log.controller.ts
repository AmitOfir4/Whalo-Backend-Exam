import { Request, Response, NextFunction } from 'express';
import { publishLog } from '../queue/publisher';

export async function createLog(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { playerId, logData, priority } = req.body;

    await publishLog(
      {
        playerId,
        logData,
        priority,
        receivedAt: new Date().toISOString(),
      },
      priority
    );

    res.status(202).json({
      message: 'Log received and queued for processing',
    });
  } catch (error) {
    next(error);
  }
}
