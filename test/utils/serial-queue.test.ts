// Serial queue tests — round4 §3-R2
//
// `--json` mode feeds stdin lines into a single QueryEngine. Without a queue,
// the 'line' callback starts the next query before the previous one finishes,
// interleaving two conversations' events on one stream.

import { describe, it, expect } from 'vitest';
import { createSerialQueue } from '../../src/utils/async-helpers';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createSerialQueue', () => {
  it('runs a single task', async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    await queue.push(async () => {
      order.push(1);
    });
    expect(order).toEqual([1]);
    expect(queue.running).toBe(false);
    expect(queue.pending).toBe(0);
  });

  it('never overlaps task execution', async () => {
    const queue = createSerialQueue();
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    // Fire three tasks at once, exactly like three stdin lines arriving together.
    const tasks = ['a', 'b', 'c'].map((name) =>
      queue.push(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${name}`);
        await tick(10);
        order.push(`end:${name}`);
        active -= 1;
        return name;
      }),
    );

    expect(queue.pending).toBeGreaterThan(0);
    const results = await Promise.all(tasks);

    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxActive).toBe(1);
    // Strict start→end pairing proves no interleaving.
    expect(order).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ]);
  });

  it('preserves FIFO order', async () => {
    const queue = createSerialQueue();
    const order: number[] = [];
    const tasks = [1, 2, 3, 4, 5].map((n) =>
      queue.push(async () => {
        await tick((5 - n) * 2); // later tasks would finish first if unserialized
        order.push(n);
      }),
    );
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps draining after a task rejects', async () => {
    const queue = createSerialQueue();
    const seen: string[] = [];

    const failing = queue.push(async () => {
      seen.push('fail');
      throw new Error('boom');
    });
    const after = queue.push(async () => {
      seen.push('after');
    });

    await expect(failing).rejects.toThrow('boom');
    await after;
    expect(seen).toEqual(['fail', 'after']);
  });

  it('reports pending/running accurately while draining', async () => {
    const queue = createSerialQueue();
    const done = queue.push(async () => {
      await tick(20);
    });
    queue.push(async () => tick(1));
    queue.push(async () => tick(1));

    await tick(0);
    expect(queue.running).toBe(true);
    expect(queue.pending).toBe(2);

    await done;
    await tick(20);
    expect(queue.running).toBe(false);
    expect(queue.pending).toBe(0);
  });
});
