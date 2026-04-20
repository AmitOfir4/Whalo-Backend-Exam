import { ConsumeMessage } from 'amqplib';
import { Log } from '../models/log.model';
import { TokenBucket } from './token-bucket';
import { Semaphore } from './concurrency';

export interface BatcherConfig {
  batchSize: number;
  batchIntervalMs: number;
  maxConcurrentWrites: number;
  tokenBucketCapacity: number;
  tokenBucketRefillRate: number;
}

interface BufferedMessage {
  data: {
    playerId: string;
    logData: string;
    receivedAt: string;
  };
  message: ConsumeMessage;
}

/**
 * Batcher — Aggregates incoming log messages and flushes them to MongoDB
 * in batches using insertMany(), controlled by:
 *   - Token Bucket: limits how frequently batches can be written
 *   - Semaphore: limits how many parallel insertMany() calls can run
 *
 * Flush triggers:
 *   1. Buffer reaches batchSize threshold
 *   2. Timer reaches batchIntervalMs since last flush
 */
export class Batcher {
  private buffer: BufferedMessage[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly config: BatcherConfig;
  private readonly tokenBucket: TokenBucket;
  private readonly semaphore: Semaphore;
  private readonly ackFn: (msg: ConsumeMessage) => void;

  constructor(config: BatcherConfig, ackFn: (msg: ConsumeMessage) => void) {
    this.config = config;
    this.tokenBucket = new TokenBucket(config.tokenBucketCapacity, config.tokenBucketRefillRate);
    this.semaphore = new Semaphore(config.maxConcurrentWrites);
    this.ackFn = ackFn;
  }

  add(data: BufferedMessage['data'], message: ConsumeMessage): void {
    this.buffer.push({ data, message });

    if (this.buffer.length >= this.config.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.config.batchIntervalMs);
    }
  }

  private async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.buffer.length === 0) return;

    const batch = [...this.buffer];
    this.buffer = [];

    try {
      // Acquire concurrency slot (wait if max parallel writes reached)
      await this.semaphore.acquire();

      try {
        // Acquire rate limit token (wait if bucket is empty)
        await this.tokenBucket.acquire();

        // Batch write to MongoDB
        const docs = batch.map((item) => ({
          playerId: item.data.playerId,
          logData: item.data.logData,
          receivedAt: new Date(item.data.receivedAt),
          processedAt: new Date(),
        }));

        await Log.insertMany(docs, { ordered: false });

        // ACK all messages in the batch only after successful write
        for (const item of batch) {
          this.ackFn(item.message);
        }

        console.log(`Flushed batch of ${batch.length} logs to database`);
      } finally {
        this.semaphore.release();
      }
    } catch (error) {
      // On failure, messages are NOT acknowledged → RabbitMQ will redeliver
      console.error(`Failed to write batch of ${batch.length} logs:`, error);
    }
  }
}
