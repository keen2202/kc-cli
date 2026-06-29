import { createHash } from 'crypto';

interface CacheEntry {
  hash: string;
  turnIndex: number;
}

/**
 * Content-hash dedup cache for file reads.
 * Prevents redundant context bloat when agent re-reads unchanged files.
 */
export class FileContentCache {
  private cache = new Map<string, CacheEntry>();
  private currentTurn = 0;
  private maxSize: number;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
  }

  setTurn(turn: number): void {
    this.currentTurn = turn;
  }

  /**
   * Check if file content has changed since last cache.
   * Returns 'fresh' on first read or changed content.
   * Returns { cachedSince: turnIndex } if content is unchanged.
   */
  check(filePath: string, content: string): 'fresh' | { cachedSince: number } {
    const hash = this.sha256(content);
    const entry = this.cache.get(filePath);
    if (entry && entry.hash === hash) {
      return { cachedSince: entry.turnIndex };
    }
    this.evictIfNeeded();
    this.cache.set(filePath, { hash, turnIndex: this.currentTurn });
    return 'fresh';
  }

  /** Invalidate a single file after write/edit. */
  invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }

  /** Invalidate all entries (session reset). */
  invalidateAll(): void {
    this.cache.clear();
  }

  /** Get cache size for metrics. */
  get size(): number {
    return this.cache.size;
  }

  private sha256(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private evictIfNeeded(): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry (Map preserves insertion order)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
  }
}
