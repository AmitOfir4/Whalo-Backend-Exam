export { connectDB } from './config/db';
export { connectRedis, getRedis } from './config/redis';
export { RabbitMQConnection } from './config/rabbitmq';
export type { RabbitMQOptions, ChannelReadyHook } from './config/rabbitmq';
export { AppError, errorHandler } from './middleware/error-handler';
export { validate, validateQuery } from './middleware/validate';

export { onShutdown } from './utils/graceful-shutdown';
export { isDuplicateKeyError, throwConflictIfDuplicate } from './utils/db-errors';
export { withDistributedLock } from './utils/distributed-lock';
export type { DistributedLockOptions } from './utils/distributed-lock';

export { LEADERBOARD_KEY, USERNAMES_KEY, TOP10_CACHE_KEY, TOP_SCORES_SET, TOP_SCORES_DATA } from './constants/redis-keys';
export { LOGS_QUEUE, PLAYER_EVENTS_QUEUE, SCORE_EVENTS_QUEUE } from './constants/queue-names';

export type { IPlayer, CreatePlayerDto, UpdatePlayerDto } from './types/player.types';
export type { IScore, CreateScoreDto, LeaderboardEntry, PaginationQuery } from './types/score.types';
export type { ILog, CreateLogDto, LogPriority } from './types/log.types';
export { LOG_PRIORITY_MAP, QUEUE_MAX_PRIORITY } from './types/log.types';
