// Per-file mutual exclusion — round4 §3-R1

import { describe, it, expect, beforeEach } from 'vitest';
import { withFileLock, activeFileLockCount, clearFileLocks } from '../../src/services/file-lock';

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withFileLock', () => {
  beforeEach(() => {
    clearFileLocks();
  });

  it('serialises access to the same key', async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];

    const run = (name: string) =>
      withFileLock('/same/file', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`start:${name}`);
        await tick(10);
        order.push(`end:${name}`);
        active -= 1;
      });

    await Promise.all([run('a'), run('b'), run('c')]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      'start:a', 'end:a',
      'start:b', 'end:b',
      'start:c', 'end:c',
    ]);
  });

  it('lets different keys run in parallel', async () => {
    let active = 0;
    let maxActive = 0;

    const run = () =>
      withFileLock(`/file/${Math.random()}`, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await tick(10);
        active -= 1;
      });

    await Promise.all([run(), run(), run()]);
    expect(maxActive).toBe(3);
  });

  it('releases the permit when fn throws', async () => {
    await expect(
      withFileLock('/boom', async () => {
        throw new Error('inner failure');
      }),
    ).rejects.toThrow('inner failure');

    // A second acquisition must not block: the permit was handed back.
    const settled = await Promise.race([
      withFileLock('/boom', async () => 'ok'),
      tick(200).then(() => 'TIMED OUT'),
    ]);
    expect(settled).toBe('ok');
  });

  it('drops the lock entry once no one is waiting (no unbounded growth)', async () => {
    expect(activeFileLockCount()).toBe(0);

    await withFileLock('/a', async () => {
      expect(activeFileLockCount()).toBe(1);
    });
    expect(activeFileLockCount()).toBe(0);

    await withFileLock('/b', async () => {});
    expect(activeFileLockCount()).toBe(0);
  });

  it('keeps the lock alive while another caller is queued', async () => {
    const first = withFileLock('/queued', async () => {
      await tick(30);
      // A second caller arrived while this one holds the lock, so the entry
      // must still exist (otherwise a third caller could slip in).
      expect(activeFileLockCount()).toBe(1);
    });
    const second = withFileLock('/queued', async () => {});

    await Promise.all([first, second]);
    expect(activeFileLockCount()).toBe(0);
  });
});
