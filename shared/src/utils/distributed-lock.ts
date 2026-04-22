import type Redis from 'ioredis';

/**
 * Distributed Redis lock helper.
 *
 * Pattern: SET key value NX PX ttl  — acquire only if absent, auto-expire so
 * a crashed holder can never deadlock the key. Used to guard expensive
 * cold-start backfills (Mongo → Redis hydration) so concurrent service
 * replicas don't all hammer Mongo at once on a cold cache.
 *
 * Semantics:
 *   - The lock-holder runs `work()` and releases on completion (success OR
 *     failure).
 *   - A caller that fails to acquire the lock briefly awaits `waitOnContendedMs`
 *     and returns without running — the expectation is the holder will have
 *     populated the cache by then, so the next request hits the fast path.
 *   - Release uses a Lua CAS so we only delete the key if the stored token
 *     still matches ours — prevents a lock that expired and was re-acquired
 *     by someone else from being deleted on our way out.
 */

export interface DistributedLockOptions
{
  key: string;
  ttlMs: number;
  waitOnContendedMs?: number;
}

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export async function withDistributedLock<T>(
  redis: Redis,
  options: DistributedLockOptions,
  work: () => Promise<T>,
): Promise<T | undefined>
{
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;

  const acquired = await redis.set(options.key, token, 'PX', options.ttlMs, 'NX');
  if (!acquired)
  {
    // Another instance holds the lock — give it a moment to finish, then bail.
    // The caller is expected to re-check the fast-path state on next entry.
    if (options.waitOnContendedMs)
    {
      await new Promise<void>((resolve) => setTimeout(resolve, options.waitOnContendedMs));
    }
    return undefined;
  }

  try
  {
    return await work();
  }
  finally
  {
    try
    {
      await redis.eval(RELEASE_SCRIPT, 1, options.key, token);
    }
    catch (err)
    {
      // Best-effort release — lock will auto-expire via PX TTL regardless.
      console.error(`Failed to release distributed lock ${options.key}:`, (err as Error).message);
    }
  }
}
