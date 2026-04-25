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
export { hydrateOnce } from './utils/hydrate-once';
export type { HydrateOnceOptions } from './utils/hydrate-once';
export { hydrateLeaderboardFromMongo } from './utils/leaderboard-hydration';
export {
  IDEMPOTENT_LEADERBOARD_INCR_LUA,
  DEFAULT_LEADERBOARD_APPLIED_TTL_SECONDS,
  evalIdempotentLeaderboardIncrement,
  resolveLeaderboardAppliedTtlSeconds,
} from './utils/idempotent-leaderboard';
export type {
  LuaEvalTarget,
  IdempotentLeaderboardIncrementArgs,
} from './utils/idempotent-leaderboard';

export {
  LEADERBOARD_KEY,
  LEADERBOARD_HYDRATED_KEY,
  PLAYERS_KNOWN_KEY,
  TOP_SCORES_SET,
  TOP_SCORES_DATA,
  APPLIED_LEADERBOARD_PREFIX,
  appliedLeaderboardKey,
} from './constants/redis-keys';
export { LOGS_QUEUE, PLAYER_EVENTS_QUEUE, SCORE_EVENTS_QUEUE } from './constants/queue-names';

export type { IPlayer } from './types/player.types';
export type { IScore } from './types/score.types';
export type { ILog, LogPriority } from './types/log.types';
export { LOG_PRIORITY_MAP, QUEUE_MAX_PRIORITY } from './types/log.types';
