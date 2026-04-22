import amqplib from 'amqplib';
import { EventEmitter } from 'events';
import type { ConfirmChannel, Options } from 'amqplib';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;

export interface RabbitMQOptions
{
  url: string;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export type ChannelReadyHook = (channel: ConfirmChannel) => Promise<void> | void;

/**
 * Managed RabbitMQ connection used by service publishers.
 *
 * Features:
 *   - Auto-reconnect on unexpected connection close, with exponential backoff
 *     (capped at maxReconnectDelayMs).
 *   - Confirm channel — publishes are acknowledged by the broker, so we get
 *     true at-least-once semantics instead of fire-and-forget.
 *   - Back-pressure — if sendToQueue reports the socket buffer is full, the
 *     next publish awaits the 'drain' event before writing. Prevents
 *     unbounded heap growth under bursty load.
 *   - onReady hooks — callbacks that run on the initial connect AND every
 *     reconnect. This is where callers declare queues, set prefetch, and
 *     (for consumer services) register their consume callback, so the
 *     topology is re-established automatically after a broker restart.
 *
 * Events emitted:
 *   - 'connected'    (channel)
 *   - 'disconnected' (err?)
 *   - 'error'        (err)
 */
export class RabbitMQConnection extends EventEmitter
{
  private connection: AmqpConnection | null = null;
  private channel: ConfirmChannel | null = null;
  private closing: boolean = false;
  private reconnectDelay: number;
  private drainPromise: Promise<void> | null = null;
  private readonly url: string;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly hooks: ChannelReadyHook[] = [];

  constructor(options: RabbitMQOptions)
  {
    super();
    this.url = options.url;
    this.initialReconnectDelayMs = options.initialReconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
    this.reconnectDelay = this.initialReconnectDelayMs;
  }

  async connect(): Promise<void>
  {
    try
    {
      this.connection = await amqplib.connect(this.url);
      this.channel = await this.connection.createConfirmChannel();

      this.connection.on('error', (err) =>
      {
        console.error('RabbitMQ connection error:', err.message);
        this.emit('error', err);
      });

      this.connection.on('close', (err?: Error) =>
      {
        this.channel = null;
        this.connection = null;
        this.drainPromise = null;
        if (!this.closing)
        {
          this.emit('disconnected', err);
          console.warn(`RabbitMQ connection lost, reconnecting in ${this.reconnectDelay}ms`);
          this.scheduleReconnect();
        }
      });

      // Re-run all registered hooks so topology + consumers re-establish
      // themselves on a fresh channel after reconnect.
      for (const hook of this.hooks)
      {
        await hook(this.channel);
      }

      this.reconnectDelay = this.initialReconnectDelayMs;
      this.emit('connected', this.channel);
      console.log('Connected to RabbitMQ');
    }
    catch (err)
    {
      console.error('RabbitMQ connect failed:', (err as Error).message);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void
  {
    if (this.closing)
    {
      return;
    }
    setTimeout(() => { void this.connect(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelayMs);
  }

  /**
   * Register a hook that runs every time the channel is (re)established.
   * Runs immediately if a channel is already open.
   */
  async onReady(hook: ChannelReadyHook): Promise<void>
  {
    this.hooks.push(hook);
    if (this.channel)
    {
      await hook(this.channel);
    }
  }

  /**
   * Publish with publisher confirms and back-pressure.
   * Resolves once the broker has confirmed persistence; rejects on nack.
   */
  async publish(queue: string, content: Buffer, options?: Options.Publish): Promise<void>
  {
    if (this.drainPromise)
    {
      await this.drainPromise;
    }

    const channel = this.channel;
    if (!channel)
    {
      throw new Error('RabbitMQ channel not available — reconnect in progress');
    }

    return new Promise<void>((resolve, reject) =>
    {
      const canContinue = channel.sendToQueue(queue, content, options, (err) =>
      {
        if (err)
        {
          reject(err);
        }
        else
        {
          resolve();
        }
      });

      if (!canContinue && !this.drainPromise)
      {
        this.drainPromise = new Promise<void>((drainResolve) =>
        {
          channel.once('drain', () =>
          {
            this.drainPromise = null;
            drainResolve();
          });
        });
      }
    });
  }

  hasChannel(): boolean
  {
    return this.channel !== null;
  }

  getChannel(): ConfirmChannel
  {
    if (!this.channel)
    {
      throw new Error('RabbitMQ channel not available');
    }
    return this.channel;
  }

  async close(): Promise<void>
  {
    this.closing = true;
    try
    {
      if (this.channel)
      {
        await this.channel.close();
      }
    }
    catch (err)
    {
      console.error('Error closing RabbitMQ channel:', (err as Error).message);
    }
    try
    {
      if (this.connection)
      {
        await this.connection.close();
      }
    }
    catch (err)
    {
      console.error('Error closing RabbitMQ connection:', (err as Error).message);
    }
  }
}
