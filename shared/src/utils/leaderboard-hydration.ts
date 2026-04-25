import type Redis from 'ioredis';
import type { Connection } from 'mongoose';
import { LEADERBOARD_KEY, LEADERBOARD_HYDRATED_KEY } from '../constants/redis-keys';
import { hydrateOnce } from './hydrate-once';

const HYDRATE_LOCK_KEY = 'leaderboard:hydrate:lock';
const HYDRATE_LOCK_TTL_MS = 30_000;
const HYDRATE_LOCK_WAIT_MS = 300;

/**
 * Cold-start hydration of the leaderboard ZSET from the `playerscores`
 * MongoDB collection. Safe to call from any service that has Redis + Mongo
 * connections — gated by the shared sentinel so it runs at most once per
 * Redis lifetime even across replicas and across services.
 *
 * `ZADD NX` is used deliberately: if score-service has already written a live
 * entry via ZINCRBY before this hydration runs, that live entry must not be
 * overwritten with the (potentially stale) Mongo value. NX preserves anything
 * already in the ZSET and only fills in members that are missing.
 */
export async function hydrateLeaderboardFromMongo(
  redis: Redis,
  connection: Connection,
): Promise<void>
{
  await hydrateOnce(
    redis,
    {
      hydratedKey: LEADERBOARD_HYDRATED_KEY,
      lock: {
        key: HYDRATE_LOCK_KEY,
        ttlMs: HYDRATE_LOCK_TTL_MS,
        waitOnContendedMs: HYDRATE_LOCK_WAIT_MS,
      },
    },
    async () =>
    {
      const db = connection.db;
      if (!db)
      {
        throw new Error('hydrateLeaderboardFromMongo: mongoose connection has no db handle');
      }

      const allScores = await db.collection('playerscores')
        .find({}, { projection: { _id: 0, playerId: 1, totalScore: 1 } })
        .toArray();

      if (allScores.length === 0)
      {
        return;
      }

      const pipeline = redis.pipeline();
      for (const doc of allScores)
      {
        // NX: only add if the member isn't already present. Live entries
        // written by score-service via ZINCRBY take precedence over the
        // backfilled Mongo total.
        pipeline.zadd(LEADERBOARD_KEY, 'NX', doc.totalScore as number, doc.playerId as string);
      }
      await pipeline.exec();
    },
  );
}
