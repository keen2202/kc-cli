// Tests for async semaphore

import { describe, it, expect, vi } from 'vitest';
import { Semaphore } from './semaphore';

describe('Semaphore', () => {
  it('creates with initial permits', () => {
    const sem = new Semaphore(5);
    expect(sem.available).toBe(5);
    expect(sem.total).toBe(5);
    expect(sem.waiting).toBe(0);
    expect(sem.isAvailable).toBe(true);
  });

  it('throws for invalid permits', () => {
    expect(() => new Semaphore(0)).toThrow('Semaphore permits must be greater than 0');
    expect(() => new Semaphore(-1)).toThrow('Semaphore permits must be greater than 0');
  });

  it('acquires and releases permits', async () => {
    const sem = new Semaphore(2);

    await sem.acquire();
    expect(sem.available).toBe(1);

    await sem.acquire();
    expect(sem.available).toBe(0);
    expect(sem.isAvailable).toBe(false);

    sem.release();
    expect(sem.available).toBe(1);
    expect(sem.isAvailable).toBe(true);

    sem.release();
    expect(sem.available).toBe(2);
  });

  it('queues when no permits available', async () => {
    const sem = new Semaphore(1);

    await sem.acquire();
    expect(sem.available).toBe(0);

    // Second acquire should wait
    const acquirePromise = sem.acquire();
    expect(sem.waiting).toBe(1);

    // Release should resolve waiting acquire
    sem.release();
    await acquirePromise;
    expect(sem.available).toBe(0);
    expect(sem.waiting).toBe(0);
  });

  it('respects timeout', async () => {
    const sem = new Semaphore(1, 100); // 100ms timeout

    await sem.acquire();

    // Second acquire should timeout
    await expect(sem.acquire()).rejects.toThrow('Semaphore acquire timeout');
    expect(sem.waiting).toBe(0);
  });

  it('executes function with permit', async () => {
    const sem = new Semaphore(1);
    let executed = false;

    const result = await sem.withPermit(async () => {
      executed = true;
      return 42;
    });

    expect(executed).toBe(true);
    expect(result).toBe(42);
    expect(sem.available).toBe(1); // Permit released
  });

  it('releases permit even on error', async () => {
    const sem = new Semaphore(1);

    await expect(
      sem.withPermit(async () => {
        throw new Error('Test error');
      })
    ).rejects.toThrow('Test error');

    expect(sem.available).toBe(1); // Permit released
  });

  it('resets semaphore', async () => {
    const sem = new Semaphore(1);

    await sem.acquire();
    expect(sem.available).toBe(0);

    // This should queue
    const waitPromise = sem.acquire();
    expect(sem.waiting).toBe(1);

    sem.reset();
    expect(sem.available).toBe(1);
    expect(sem.waiting).toBe(0);

    await expect(waitPromise).rejects.toThrow('Semaphore reset');
  });

  it('handles concurrent acquisitions', async () => {
    const sem = new Semaphore(3);
    const results: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      sem.withPermit(async () => {
        results.push(i);
        await new Promise(resolve => setTimeout(resolve, 10));
        return i;
      })
    );

    await Promise.all(tasks);
    expect(results).toHaveLength(5);
    expect(sem.available).toBe(3);
  });

  it('maintains FIFO order for waiting callers', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];

    await sem.acquire();

    // Queue 3 waiters
    const waiter1 = sem.withPermit(async () => { order.push(1); });
    const waiter2 = sem.withPermit(async () => { order.push(2); });
    const waiter3 = sem.withPermit(async () => { order.push(3); });

    // Release the initial permit
    sem.release();

    await Promise.all([waiter1, waiter2, waiter3]);
    expect(order).toEqual([1, 2, 3]);
  });
});
