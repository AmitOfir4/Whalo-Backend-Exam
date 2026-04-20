export const LEADERBOARD_KEY = 'leaderboard';
export const USERNAMES_KEY = 'leaderboard:usernames';
export const TOP10_CACHE_KEY = 'top10scores';

// Top 10 individual scores — Redis sorted set + hash for O(log N) reads
export const TOP_SCORES_SET = 'top10scores:set';   // ZSET: score → playerId:timestamp
export const TOP_SCORES_DATA = 'top10scores:data'; // HASH: playerId:timestamp → JSON metadata
