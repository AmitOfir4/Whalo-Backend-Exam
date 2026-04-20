export { connectDB } from './config/db';
export { AppError, errorHandler } from './middleware/error-handler';
export { validate, validateQuery } from './middleware/validate';

export type { IPlayer, CreatePlayerDto, UpdatePlayerDto } from './types/player.types';
export type { IScore, CreateScoreDto, LeaderboardEntry, PaginationQuery } from './types/score.types';
export type { ILog, CreateLogDto } from './types/log.types';
