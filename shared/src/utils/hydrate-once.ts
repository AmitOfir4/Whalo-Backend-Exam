import type Redis from 'ioredis';
import { withDistributedLock, DistributedLockOptions } from './distributed-lock';

/**
 * Sentinel-gated, lock-wrapped one-shot hydration.
 *
 * Why a sentinel instead of "is the cache empty?": the cache's own size
 * (ZCARD / SCARD) is not a reliable "already hydrated" signal. A writer can
 * populate the cache with the current request's deltas before any reader has
 * had a chance to backfill historical state, making the size check false-
 * positive and skipping hydration permanently for that Redis lifetime.
 * Gating on a dedicated sentinel decouples "cache has data" from "we have
 * reconciled with the source of truth".
 *
 * Semantics:
 *   - Fast path: if the sentinel exists, return immediately.
 *   - Otherwise acquire a distributed lock so only one replica performs the
 *     (potentially expensive) Mongo read; concurrent callers wait briefly
 *     and return, expecting the next call to hit the fast path.
 *   - Re-check inside the lock to absorb the case where another replica
 *     finished hydration while we were acquiring.
 *   - On successful completion, atomically set the sentinel.
 *   - The sentinel has no TTL: a Redis flush wipes it alongside the cache,
 *     so subsequent calls re-hydrate naturally.
 *
 * If `work()` throws, the sentinel is NOT set, so the next call retries.
 */
export interface HydrateOnceOptions
{
  hydratedKey: string;
  lock: DistributedLockOptions;
}

export async function hydrateOnce(
  redis: Redis,
  options: HydrateOnceOptions,
  work: () => Promise<void>,
): Promise<void>
{
  // Fast path — already hydrated for this Redis lifetime.
  if ((await redis.exists(options.hydratedKey)) === 1)
  {
    return;
  }

  await withDistributedLock(redis, options.lock, async () =>
  {
    // Re-check inside the lock in case another replica just finished.
    if ((await redis.exists(options.hydratedKey)) === 1)
    {
      return;
    }

    await work();

    // Mark hydration complete only after work() succeeded. If work() threw,
    // we never reach here and the next caller will retry under the lock.
    await redis.set(options.hydratedKey, '1');
  });
}
