import { ConsumeMessage } from 'amqplib';
import mongoose from 'mongoose';
import {
  getRedis,
  TOP_SCORES_SET,
  TOP_SCORES_DATA,
  evalIdempotentLeaderboardIncrement,
  resolveLeaderboardAppliedTtlSeconds,
} from '@whalo/shared';
import { TokenBucket } from './token-bucket';
import { Semaphore } from './concurrency';

export interface BatcherConfig
{
  batchSize: number;
  batchIntervalMs: number;
  maxConcurrentWrites: number;
  tokenBucketCapacity: number;
  tokenBucketRefillRate: number;
}

interface BufferedMessage
{
  data: {
    playerId: string;
    username: string;
    score: number;
    timestamp: number;
  };
  message: ConsumeMessage;
}

// Lua script to maintain the top-10 individual scores sorted set atomically.
// Identical to the script in score-service — both sides share the same scoreKey
// so the ZADD/HSET are idempotent when the worker processes the same event.
const TOP_SCORES_LUA = `
local setKey  = KEYS[1]
local hashKey = KEYS[2]
local score   = tonumber(ARGV[1])
local member  = ARGV[2]
local payload = ARGV[3]

redis.call('ZADD', setKey, score, member)
redis.call('HSET', hashKey, member, payload)

local count = redis.call('ZCARD', setKey)
if count > 10 then
  local evicted = redis.call('ZRANGE', setKey, 0, count - 11)
  redis.call('ZREMRANGEBYRANK', setKey, 0, count - 11)
  for _, k in ipairs(evicted) do redis.call('HDEL', hashKey, k) end
end

return 1
`;

/**
 * Batcher — Aggregates incoming score messages and flushes them to MongoDB
 * in batches using insertMany() + bulkWrite(), controlled by:
 *   - Token Bucket: limits how frequently batches can be written
 *   - Semaphore: limits how many parallel flush calls can run concurrently
 *
 * Flush triggers:
 *   1. Buffer reaches batchSize threshold
 *   2. Timer fires after batchIntervalMs since the first message was buffered
 *
 * On failure: all messages in the batch are nack'd with requeue=true.
 * A unique index on scores { playerId, createdAt } makes insertMany idempotent
 * on retry: duplicate-key (11000) errors are absorbed and only genuinely new
 * score documents drive the downstream $inc and Redis writes, preventing
 * double-counting of totalScore / gamesPlayed.
 */
export class Batcher
{
  private buffer: BufferedMessage[] = [];
  private timer: NodeJS.Timeout | null = null;
  private activeFlushes: number = 0;
  private drainResolve: (() => void) | null = null;
  private readonly config: BatcherConfig;
  private readonly tokenBucket: TokenBucket;
  private readonly semaphore: Semaphore;
  private readonly ackFn: (msg: ConsumeMessage) => void;
  private readonly nackFn: (msg: ConsumeMessage) => void;

  constructor(
    config: BatcherConfig,
    ackFn: (msg: ConsumeMessage) => void,
    nackFn: (msg: ConsumeMessage) => void,
  )
  {
    this.config = config;
    this.tokenBucket = new TokenBucket(config.tokenBucketCapacity, config.tokenBucketRefillRate);
    this.semaphore = new Semaphore(config.maxConcurrentWrites);
    this.ackFn = ackFn;
    this.nackFn = nackFn;
  }

  add(data: BufferedMessage['data'], message: ConsumeMessage): void
  {
    this.buffer.push({ data, message });

    if (this.buffer.length >= this.config.batchSize)
    {
      this.flush();
    }
    else if (!this.timer)
    {
      this.timer = setTimeout(() => this.flush(), this.config.batchIntervalMs);
    }
  }

  private async flush(): Promise<void>
  {
    if (this.timer)
    {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0)
    {
      return;
    }

    const batch = [...this.buffer];
    this.buffer = [];

    this.activeFlushes++;
    try
    {
      // Acquire concurrency slot (waits if max parallel flushes are already running)
      await this.semaphore.acquire();

      try
      {
        // Acquire rate-limit token (waits if bucket is empty)
        await this.tokenBucket.acquire();

        const db = mongoose.connection.db!;
        const redis = getRedis();

        // 1. Insert individual score records — ordered:false so duplicate-key
        //    errors on retry are absorbed rather than thrown.
        const scoreDocs = batch.map((item) => ({
          playerId: item.data.playerId,
          username: item.data.username,
          score: item.data.score,
          createdAt: new Date(item.data.timestamp),
        }));

        // Track which messages are genuinely new insertions vs already-persisted
        // duplicates. On a nack+retry the unique index on { playerId, createdAt }
        // causes already-persisted documents to throw duplicate-key (11000) errors;
        // those items are excluded from the downstream $inc and Redis writes so we
        // never double-count totalScore / gamesPlayed.
        let newBatch = batch;
        try
        {
          await db.collection('scores').insertMany(scoreDocs, { ordered: false });
        }
        catch (insertErr)
        {
          // A BulkWriteError with only duplicate-key (11000) errors means every
          // document in this batch was already persisted on a previous attempt.
          // Other errors are re-thrown so the batch is nack'd and retried.
          if (
            typeof insertErr !== 'object' ||
            insertErr === null ||
            !('code' in insertErr) &&
            !('writeErrors' in insertErr)
          )
          {
            throw insertErr;
          }
          const bulkErr = insertErr as { code?: number; writeErrors?: any[] | any };
          // Normalise writeErrors to an array
          const writeErrors: any[] = Array.isArray(bulkErr.writeErrors)
            ? bulkErr.writeErrors
            : bulkErr.writeErrors != null
            ? [bulkErr.writeErrors]
            : [];
          const hasFatalErrors = writeErrors.some((e) => e.code !== 11000);
          if (hasFatalErrors || writeErrors.length === 0)
          {
            throw insertErr;
          }
          // Determine which indices failed (duplicates) and keep only the new ones
          const failedIndices = new Set<number>(writeErrors.map((e) => e.index));
          newBatch = batch.filter((_, i) => !failedIndices.has(i));
        }

        // All scores were already persisted in a previous attempt — ACK and exit
        // without re-running the downstream writes that would double-count stats.
        if (newBatch.length === 0)
        {
          for (const item of batch)
          {
            this.ackFn(item.message);
          }
          console.log(`Batch of ${batch.length} scores already persisted — skipping redundant writes`);
          return;
        }

        const playerScoreOps = newBatch.map((item) => ({
          updateOne: {
            filter: { playerId: item.data.playerId },
            update: {
              $inc: { totalScore: item.data.score, gamesPlayed: 1 },
            },
            upsert: true,
          },
        }));

        // 3. Redis ops — pipelined for genuinely new scores only.
        //
        //    Leaderboard ZINCRBY is run through an idempotent Lua script:
        //    the Score Service already applied it synchronously on the HTTP
        //    path so the client sees the new total immediately. The worker
        //    re-runs the same script here so that if the service crashed
        //    before publishing, or the sync path was skipped for any reason,
        //    the leaderboard still catches up. The SET NX applied-marker
        //    inside the script makes the second call a no-op.
        const pipeline = redis.pipeline();
        const ttlSeconds = resolveLeaderboardAppliedTtlSeconds();
        for (const item of newBatch)
        {
          const scoreKey = `${item.data.playerId}:${item.data.timestamp}`;
          const metadata = JSON.stringify(
          {
            playerId: item.data.playerId,
            score: item.data.score,
            createdAt: new Date(item.data.timestamp).toISOString(),
          });

          evalIdempotentLeaderboardIncrement(pipeline, {
            playerId: item.data.playerId,
            score: item.data.score,
            scoreKey,
            ttlSeconds,
          });
          pipeline.eval(
            TOP_SCORES_LUA,
            2,
            TOP_SCORES_SET,
            TOP_SCORES_DATA,
            item.data.score,
            scoreKey,
            metadata,
          );
        }

        await Promise.all([
          db.collection('playerscores').bulkWrite(playerScoreOps, { ordered: false }),
          pipeline.exec(),
        ]);

        // ACK all messages only after all writes have succeeded
        for (const item of batch)
        {
          this.ackFn(item.message);
        }

        console.log(`Flushed batch of ${batch.length} scores to database`);
      }
      finally
      {
        this.semaphore.release();
      }
    }
    catch (error)
    {
      console.error(`Failed to write batch of ${batch.length} scores:`, error);
      // Nack all messages so RabbitMQ redelivers them — safe to retry
      for (const item of batch)
      {
        this.nackFn(item.message);
      }
    }
    finally
    {
      this.activeFlushes--;
      if (this.activeFlushes === 0 && this.drainResolve)
      {
        this.drainResolve();
        this.drainResolve = null;
      }
    }
  }

  /**
   * Flush remaining buffered messages and wait for all in-progress writes to
   * complete before the process exits. Called during graceful shutdown.
   */
  async shutdown(): Promise<void>
  {
    await this.flush();

    if (this.activeFlushes > 0)
    {
      await new Promise<void>((resolve) =>
      {
        this.drainResolve = resolve;
      });
    }
  }
}
