import { LEADERBOARD_KEY, appliedLeaderboardKey } from '../constants/redis-keys';

/**
 * Idempotent leaderboard increment.
 *
 * Problem: `ZINCRBY` is not idempotent. Under at-least-once delivery a
 * redelivered message would double-count `totalScore`. That is why, in the
 * original design, only the Score Worker ran `ZINCRBY` — so a single
 * authoritative writer was responsible for each score. The unfortunate
 * side-effect is that visible leaderboard totals lag by the full depth of
 * the `score_events` queue: under a heavy backlog the user's submission
 * waits in FIFO until the worker finally processes it.
 *
 * Fix: gate the increment behind an idempotency marker. The marker is a
 * self-expiring Redis key keyed by `scoreKey = playerId:timestamp` — the
 * same identifier the top-10 Lua script already uses. `SET NX` atomically
 * creates the marker; the `ZINCRBY` only runs when the marker is newly
 * created. Both the Score Service (sync path, for immediate visibility)
 * and the Score Worker (async path, for durability after the MongoDB
 * write succeeds) execute this same script. Whichever runs first applies
 * the increment; the other is a no-op.
 *
 * Correctness invariant: the marker TTL must exceed the maximum expected
 * lag between a message being published and the worker processing it.
 * Default 24h is conservative — if the queue backlog ever exceeds that,
 * operational issues are much larger than a leaderboard double-count.
 */
export const IDEMPOTENT_LEADERBOARD_INCR_LUA = `
-- KEYS[1] = leaderboard ZSET
-- KEYS[2] = applied-marker key for this scoreKey
-- ARGV[1] = playerId (ZSET member)
-- ARGV[2] = score (increment amount)
-- ARGV[3] = marker TTL in seconds

local applied = redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[3]))
if applied then
  redis.call('ZINCRBY', KEYS[1], tonumber(ARGV[2]), ARGV[1])
  return 1
end
return 0
`;

export const DEFAULT_LEADERBOARD_APPLIED_TTL_SECONDS = 86_400; // 24 hours

/**
 * Minimal structural type covering both ioredis clients and pipelines —
 * both expose `.eval(script, numKeys, ...args)`. This lets the same helper
 * be invoked from the Score Service (awaited) and the Score Worker
 * (queued onto a pipeline).
 */
export interface LuaEvalTarget
{
  eval(script: string, numKeys: number | string, ...args: (string | number)[]): unknown;
}

export interface IdempotentLeaderboardIncrementArgs
{
  playerId: string;
  score: number;
  scoreKey: string;
  ttlSeconds: number;
}

/**
 * Execute (or enqueue, on a pipeline) the idempotent leaderboard increment
 * script. Returns whatever the underlying `eval` returns — a Promise<1|0>
 * on a Redis client, or the pipeline itself for chaining.
 */
export function evalIdempotentLeaderboardIncrement(
  target: LuaEvalTarget,
  { playerId, score, scoreKey, ttlSeconds }: IdempotentLeaderboardIncrementArgs,
): unknown
{
  return target.eval(
    IDEMPOTENT_LEADERBOARD_INCR_LUA,
    2,
    LEADERBOARD_KEY,
    appliedLeaderboardKey(scoreKey),
    playerId,
    score,
    ttlSeconds,
  );
}

/**
 * Resolve the applied-marker TTL from env (`LEADERBOARD_APPLIED_TTL_SECONDS`),
 * falling back to the 24h default. Callers read at request / batch time so
 * the value can be tuned without restarting the shared module.
 */
export function resolveLeaderboardAppliedTtlSeconds(): number
{
  const raw = process.env.LEADERBOARD_APPLIED_TTL_SECONDS;
  if (!raw) return DEFAULT_LEADERBOARD_APPLIED_TTL_SECONDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LEADERBOARD_APPLIED_TTL_SECONDS;
}
