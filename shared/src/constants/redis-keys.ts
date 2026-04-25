export const LEADERBOARD_KEY = 'leaderboard';

// Sentinel key written after the leaderboard ZSET has been backfilled from
// MongoDB. Hydration gates on the sentinel rather than ZCARD because ZCARD > 0
// is not a reliable "already hydrated" signal — a writer (score-service) can
// ZINCRBY a single new entry into a fresh, un-hydrated ZSET, which would make
// ZCARD > 0 fire false-positive and skip the historical backfill. The sentinel
// has no TTL: a Redis flush wipes it alongside the cache, so the next
// hydration call re-runs naturally.
export const LEADERBOARD_HYDRATED_KEY = 'leaderboard:hydrated';

// Redis SET of playerIds known to score-service — populated by
// `player.created` events and pruned by `player.deleted`. Used by the
// score-submit path (SISMEMBER) to reject scores for nonexistent players
// without crossing the player-service boundary for every submission.
export const PLAYERS_KNOWN_KEY = 'players:known';

// Top 10 individual scores — Redis sorted set + hash for O(log N) reads
export const TOP_SCORES_SET = 'top10scores:set';   // ZSET: score → playerId:timestamp
export const TOP_SCORES_DATA = 'top10scores:data'; // HASH: playerId:timestamp → JSON metadata

// Idempotency markers for leaderboard ZINCRBY. One self-expiring key per
// scoreKey — SET NX gates the increment so the same score cannot be applied
// twice, even when both the Score Service (sync path) and the Score Worker
// (async path) run the same script for the same message.
export const APPLIED_LEADERBOARD_PREFIX = 'applied:leaderboard:';
export const appliedLeaderboardKey = (scoreKey: string): string =>
  `${APPLIED_LEADERBOARD_PREFIX}${scoreKey}`;
