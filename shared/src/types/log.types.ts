export type LogPriority = 'low' | 'normal' | 'high';

export const LOG_PRIORITY_MAP: Record<LogPriority, number> = {
  low: 1,
  normal: 2,
  high: 3,
};

export const QUEUE_MAX_PRIORITY = 3;

export interface ILog {
  playerId: string;
  logData: string;
  priority: LogPriority;
  receivedAt: Date;
  processedAt?: Date;
}
