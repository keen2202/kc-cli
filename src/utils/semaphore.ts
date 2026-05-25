// Async semaphore for concurrency control

/**
 * Async semaphore that limits concurrent access to a resource.
 * Useful for controlling parallel tool execution.
 */
export class Semaphore {
  private permits: number;
  private waitQueue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly maxPermits: number;

  /**
   * Create a new semaphore.
   * @param permits Number of concurrent permits (must be > 0)
   * @param timeoutMs Optional timeout for waiting permits (0 = no timeout)
   */
  constructor(
    permits: number,
    private readonly timeoutMs: number = 0
  ) {
    if (permits <= 0) {
      throw new Error('Semaphore permits must be greater than 0');
    }
    this.permits = permits;
    this.maxPermits = permits;
  }

  /**
   * Acquire a permit. Resolves when a permit is available.
   * Rejects if timeout is exceeded.
   */
  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve, reject) => {
      const entry: {
        resolve: () => void;
        reject: (error: Error) => void;
        timeoutId?: ReturnType<typeof setTimeout>;
      } = { resolve, reject };

      if (this.timeoutMs > 0) {
        entry.timeoutId = setTimeout(() => {
          const index = this.waitQueue.indexOf(entry);
          if (index !== -1) {
            this.waitQueue.splice(index, 1);
          }
          reject(new Error(`Semaphore acquire timeout after ${this.timeoutMs}ms`));
        }, this.timeoutMs);
      }

      this.waitQueue.push(entry);
    });
  }

  /**
   * Release a permit. Makes it available for waiting callers.
   */
  release(): void {
    if (this.waitQueue.length > 0) {
      const entry = this.waitQueue.shift()!;
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
      entry.resolve();
    } else {
      this.permits++;
    }
  }

  /**
   * Execute an async function with a permit.
   * Automatically acquires and releases the permit.
   */
  async withPermit<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /**
   * Get the number of available permits.
   */
  get available(): number {
    return this.permits;
  }

  /**
   * Get the number of waiting callers.
   */
  get waiting(): number {
    return this.waitQueue.length;
  }

  /**
   * Get the total number of permits (max).
   */
  get total(): number {
    return this.maxPermits;
  }

  /**
   * Check if a permit is immediately available.
   */
  get isAvailable(): boolean {
    return this.permits > 0;
  }

  /**
   * Reset the semaphore to its initial state.
   * Rejects all waiting callers.
   */
  reset(): void {
    const error = new Error('Semaphore reset');
    while (this.waitQueue.length > 0) {
      const entry = this.waitQueue.shift()!;
      if (entry.timeoutId) {
        clearTimeout(entry.timeoutId);
      }
      entry.reject(error);
    }
    this.permits = this.maxPermits;
  }
}
