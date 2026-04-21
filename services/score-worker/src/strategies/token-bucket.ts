/**
 * Token Bucket Rate Limiter
 *
 * Controls the rate of database writes by issuing tokens at a fixed rate.
 * A write can only proceed if a token is available. Tokens refill over time
 * up to a maximum capacity, allowing controlled bursts.
 */
export class TokenBucket
{
  private tokens: number;
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second
  private lastRefillTime: number;

  constructor(capacity: number, refillRate: number)
  {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.tokens = capacity;
    this.lastRefillTime = Date.now();
  }

  private refill(): void
  {
    const now = Date.now();
    const elapsed = (now - this.lastRefillTime) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefillTime = now;
  }

  async acquire(): Promise<void>
  {
    this.refill();

    if (this.tokens >= 1)
    {
      this.tokens -= 1;
      return;
    }

    // Wait until a token is available
    const waitTime = ((1 - this.tokens) / this.refillRate) * 1000;
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    this.refill();
    this.tokens -= 1;
  }
}
