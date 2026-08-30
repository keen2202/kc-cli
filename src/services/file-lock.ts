// Per-file mutual exclusion — round4 §3-R1
//
// The concurrency `Semaphore` used elsewhere in the codebase bounds *how many*
// operations run at once; it does nothing to stop two of them touching the same
// file. FileEdit's read-modify-write is the one place in the project where that
// gap silently loses user data: two agents read the same content, both write,
// and the second write erases the first edit entirely.
//
// This module adds the missing mutual-exclusion layer: one permit per
// (resolved) path, so concurrent edits to the same file serialise while edits
// to different files still run in parallel.

import { Semaphore } from '../utils/semaphore';

interface LockEntry {
  semaphore: Semaphore;
  /** Number of callers waiting for or holding this lock. */
  waiters: number;
}

const locks = new Map<string, LockEntry>();

/** Diagnostics: how many paths currently have a live lock entry. */
export function activeFileLockCount(): number {
  return locks.size;
}

/** Test/diagnostic escape hatch. Never call while operations are in flight. */
export function clearFileLocks(): void {
  locks.clear();
}

/**
 * Run `fn` with exclusive access to `key` (normally an absolute, realpath-resolved
 * file path). Nested acquisition of the *same* key from the same call stack will
 * deadlock — callers must not re-enter.
 *
 * The lock entry is dropped once no other caller is waiting, so the map does
 * not grow without bound.
 */
export async function withFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let entry = locks.get(key);
  if (!entry) {
    entry = { semaphore: new Semaphore(1), waiters: 0 };
    locks.set(key, entry);
  }
  entry.waiters += 1;

  try {
    await entry.semaphore.acquire();
  } catch (error) {
    entry.waiters -= 1;
    if (entry.waiters === 0) locks.delete(key);
    throw error;
  }

  try {
    return await fn();
  } finally {
    entry.semaphore.release();
    entry.waiters -= 1;
    // Clean up only when nothing else is queued: deleting a lock that another
    // caller already holds a reference to would let a third caller in.
    if (entry.waiters === 0) locks.delete(key);
  }
}
