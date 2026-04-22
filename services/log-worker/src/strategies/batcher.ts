import { ConsumeMessage } from 'amqplib';
import { Log } from '../models/log.model';
import { TokenBucket } from './token-bucket';
import { Semaphore } from './concurrency';
import type { LogPriority } from '@whalo/shared';

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
    logData: string;
    priority: LogPriority;
    receivedAt: string;
  };
  message: ConsumeMessage;
}

// High-priority logs flush at a smaller batch threshold so they don't wait
const HIGH_PRIORITY_BATCH_DIVISOR = 5;
const HIGH_PRIORITY_INTERVAL_DIVISOR = 4;

export type AckFn = (msg: ConsumeMessage) => void;
export type NackFn = (msg: ConsumeMessage, requeue: boolean) => void;

/**
 * Batcher — Aggregates incoming log messages and flushes them to MongoDB
 * in batches using insertMany(), controlled by:
 *   - Token Bucket: limits how frequently batches can be written
 *   - Semaphore: limits how many parallel insertMany() calls can run
 *   - Priority-aware flushing: high-priority logs trigger faster flushes
 *
 * Flush triggers:
 *   1. Buffer reaches batchSize threshold (lower for high-priority)
 *   2. Timer reaches batchIntervalMs since last flush
 *
 * Failure handling:
 *   A batch that fails to persist is nack'd with requeue=true so RabbitMQ
 *   re-delivers it. Without this, the messages would sit in the broker's
 *   "unacked" bucket forever, slowly consuming the prefetch window until
 *   the worker stalls entirely.
 */
export class Batcher
{
  private buffer: BufferedMessage[] = [];
  private timer: NodeJS.Timeout | null = null;
  private hasHighPriority: boolean = false;
  private activeFlushes: number = 0;
  private drainResolve: (() => void) | null = null;
  private readonly config: BatcherConfig;
  private readonly tokenBucket: TokenBucket;
  private readonly semaphore: Semaphore;
  private readonly ackFn: AckFn;
  private readonly nackFn: NackFn;

  constructor(config: BatcherConfig, ackFn: AckFn, nackFn: NackFn)
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

    if (data.priority === 'high')
    {
      this.hasHighPriority = true;
    }

    // Use a smaller batch threshold when high-priority messages are present
    const threshold = this.hasHighPriority
      ? Math.max(1, Math.floor(this.config.batchSize / HIGH_PRIORITY_BATCH_DIVISOR))
      : this.config.batchSize;

    if (this.buffer.length >= threshold)
    {
      this.flush();
    }
    else if (!this.timer)
    {
      // Use a shorter interval when high-priority messages are waiting
      const interval = this.hasHighPriority
        ? Math.floor(this.config.batchIntervalMs / HIGH_PRIORITY_INTERVAL_DIVISOR)
        : this.config.batchIntervalMs;
      this.timer = setTimeout(() => this.flush(), interval);
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
    this.hasHighPriority = false;

    this.activeFlushes++;
    let writeSucceeded = false;
    try
    {
      // Acquire concurrency slot (wait if max parallel writes reached)
      await this.semaphore.acquire();

      try
      {
        // Acquire rate limit token (wait if bucket is empty)
        await this.tokenBucket.acquire();

        // Batch write to MongoDB
        const docs = batch.map((item) => ({
          playerId: item.data.playerId,
          logData: item.data.logData,
          priority: item.data.priority || 'normal',
          receivedAt: new Date(item.data.receivedAt),
          processedAt: new Date(),
        }));

        await Log.insertMany(docs, { ordered: false });
        writeSucceeded = true;

        // ACK all messages in the batch only after successful write
        for (const item of batch)
        {
          this.ackFn(item.message);
        }

        console.log(`Flushed batch of ${batch.length} logs to database`);
      }
      finally
      {
        this.semaphore.release();
      }
    }
    catch (error)
    {
      console.error(`Failed to write batch of ${batch.length} logs:`, error);
    }
    finally
    {
      // On failure, nack (with requeue) every message in the batch so
      // RabbitMQ redelivers them instead of leaving them as "unacked in
      // flight" — which would quietly fill the prefetch window and stall
      // the worker.
      if (!writeSucceeded)
      {
        for (const item of batch)
        {
          try
          {
            this.nackFn(item.message, true);
          }
          catch (nackErr)
          {
            // Channel may have been torn down by the time we're nacking.
            // Nothing we can do beyond logging — the consumer will be
            // restarted and the broker will redeliver unacked messages.
            console.error('Failed to nack message after flush failure:', (nackErr as Error).message);
          }
        }
      }

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
    // Flush any messages still in the buffer
    await this.flush();

    // Wait for any concurrently running flushes to finish
    if (this.activeFlushes > 0)
    {
      await new Promise<void>((resolve) =>
      {
        this.drainResolve = resolve;
      });
    }
  }
}
