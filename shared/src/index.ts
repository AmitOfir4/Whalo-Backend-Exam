export { connectDB } from './config/db';
export { connectRedis, getRedis } from './config/redis';
export { AppError, errorHandler } from './middleware/error-handler';
export { validate, validateQuery } from './middleware/validate';

export { LEADERBOARD_KEY, USERNAMES_KEY, TOP10_CACHE_KEY } from './constants/redis-keys';
export { LOGS_QUEUE, PLAYER_EVENTS_QUEUE } from './constants/queue-names';

export type { IPlayer, CreatePlayerDto, UpdatePlayerDto } from './types/player.types';
export type { IScore, CreateScoreDto, LeaderboardEntry, PaginationQuery } from './types/score.types';
export type { ILog, CreateLogDto } from './types/log.types';
