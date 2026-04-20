/**
 * Semaphore-based Concurrency Control
 *
 * Restricts the number of simultaneous database write operations to prevent
 * overloading MongoDB connections. Uses a classic semaphore pattern where
 * workers acquire a slot before writing and release it after completion.
 */
export class Semaphore {
  private current: number = 0;
  private readonly max: number;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = max;
  }

  async acquire(): Promise<void> {
    if (this.current < this.max) {
      this.current++;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.current++;
        resolve();
      });
    });
  }

  release(): void {
    this.current--;
    const next = this.queue.shift();
    if (next) {
      next();
    }
  }
}
