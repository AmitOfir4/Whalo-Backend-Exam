export interface ILog {
  playerId: string;
  logData: string;
  receivedAt: Date;
  processedAt?: Date;
}

export interface CreateLogDto {
  playerId: string;
  logData: string;
}
