export const LEADERBOARD_KEY = 'leaderboard';
export const USERNAMES_KEY = 'leaderboard:usernames';
export const TOP10_CACHE_KEY = 'top10scores';

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
