// Descriptor-leak measurement helpers for file-read tests (round4 §2-S5).
//
// Two independent strategies:
//
// 1. `readStreamStats` — deterministic and platform-independent. Wraps
//    `fs.createReadStream` and counts created vs. closed streams, so a stream
//    that is never `destroy()`ed shows up as a non-zero `leaked()` count.
// 2. `countOpenFds` — coarse but real. POSIX reads `/proc/self/fd`; Windows
//    falls back to counting filesystem-shaped entries in Node's active handles.

import { readdirSync } from 'node:fs';

type ActiveHandle = { constructor?: { name?: string } };

const FS_HANDLE_NAMES = new Set(['ReadStream', 'WriteStream', 'FileHandle']);

export interface ReadStreamStats {
  created: number;
  closed: number;
  reset(): void;
  /** Streams opened but never closed. */
  leaked(): number;
}

/**
 * Shared counter used by a `vi.mock('fs')` factory. Lives in a helper module
 * because the mock factory is hoisted above normal test-file bindings.
 */
export const readStreamStats: ReadStreamStats = {
  created: 0,
  closed: 0,
  reset() {
    this.created = 0;
    this.closed = 0;
  },
  leaked() {
    return this.created - this.closed;
  },
};

/**
 * Wrap `fs.createReadStream` so every stream opened through the mocked module
 * is counted, and counted again when it actually closes. `stream.destroy()`
 * emits 'close'; a stream that is merely abandoned does not.
 */
export function wrapCreateReadStream(
  createReadStream: (...args: unknown[]) => NodeJS.ReadableStream,
): (...args: unknown[]) => NodeJS.ReadableStream {
  return (...args: unknown[]) => {
    const stream = createReadStream(...args);
    readStreamStats.created += 1;
    stream.on('close', () => {
      readStreamStats.closed += 1;
    });
    return stream;
  };
}

function countProcFds(): number | null {
  try {
    return readdirSync('/proc/self/fd').length;
  } catch {
    return null; // not POSIX, or /proc unavailable
  }
}

function countFsHandles(): number {
  const getActiveHandles = (process as unknown as { _getActiveHandles?: () => ActiveHandle[] })
    ._getActiveHandles;
  if (typeof getActiveHandles !== 'function') return -1;
  return getActiveHandles().filter((h) => {
    const name = h?.constructor?.name;
    return name !== undefined && FS_HANDLE_NAMES.has(name);
  }).length;
}

/** Best available open-descriptor count, or -1 when no strategy applies. */
export function countOpenFds(): number {
  const procCount = countProcFds();
  return procCount ?? countFsHandles();
}
