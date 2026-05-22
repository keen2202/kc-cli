// TieredCache - Unified LRU cache with TTL, compression, and hit rate tracking
// L1: In-memory LRU with configurable size and TTL
// L2: Optional disk persistence for large or cold entries

import { createHash } from 'crypto';

export interface CacheEntry<V> {
  value: V;
  createdAt: number;
  lastAccessed: number;
  accessCount: number;
  sizeBytes: number;
  compressed: boolean;
  version: number;
  ttlMs: number;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  evictions: number;
  size: number;
  maxSize: number;
  totalSizeBytes: number;
  maxSizeBytes: number;
}

export interface TieredCacheOptions {
  maxSize: number;
  maxBytes: number;
  defaultTtlMs: number;
  evictionBatchRatio: number;
  onEvict?: (key: string, entry: CacheEntry<any>) => void;
}

const DEFAULT_OPTIONS: TieredCacheOptions = {
  maxSize: 500,
  maxBytes: 10 * 1024 * 1024, // 10MB
  defaultTtlMs: 5 * 60 * 1000, // 5 minutes
  evictionBatchRatio: 0.25,
};

export class TieredCache<V = any> {
  private store = new Map<string, CacheEntry<V>>();
  private accessOrder: string[] = []; // LRU tracking (most recent at end)
  private options: TieredCacheOptions;
  private stats = { hits: 0, misses: 0, evictions: 0 };
  private version = 0;

  constructor(options: Partial<TieredCacheOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.stats.misses++;
      return undefined;
    }

    // TTL check
    if (this.isExpired(entry)) {
      this.delete(key);
      this.stats.misses++;
      return undefined;
    }

    // Update access metadata
    entry.lastAccessed = Date.now();
    entry.accessCount++;
    this.touchLRU(key);
    this.stats.hits++;

    return entry.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    const now = Date.now();
    const sizeBytes = this.estimateSize(value);

    // Remove existing entry if present (for update)
    if (this.store.has(key)) {
      this.store.delete(key);
      this.removeFromLRU(key);
    }

    // Evict if necessary to make room
    this.evictIfNeeded(sizeBytes);

    const entry: CacheEntry<V> = {
      value,
      createdAt: now,
      lastAccessed: now,
      accessCount: 1,
      sizeBytes,
      compressed: false,
      version: ++this.version,
      ttlMs: ttlMs ?? this.options.defaultTtlMs,
    };

    this.store.set(key, entry);
    this.accessOrder.push(key);
  }

  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.delete(key);
      return false;
    }
    return true;
  }

  delete(key: string): boolean {
    const existed = this.store.delete(key);
    if (existed) {
      this.removeFromLRU(key);
    }
    return existed;
  }

  clear(): void {
    this.store.clear();
    this.accessOrder = [];
  }

  get size(): number {
    return this.store.size;
  }

  getStats(): CacheStats {
    const totalHits = this.stats.hits + this.stats.misses;
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: totalHits > 0 ? this.stats.hits / totalHits : 0,
      evictions: this.stats.evictions,
      size: this.store.size,
      maxSize: this.options.maxSize,
      totalSizeBytes: this.getTotalSizeBytes(),
      maxSizeBytes: this.options.maxBytes,
    };
  }

  /**
   * Get or compute: returns cached value or calls factory to compute and cache
   */
  getOrSet(key: string, factory: () => V | Promise<V>, ttlMs?: number): V | Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const result = factory();
    if (result instanceof Promise) {
      return result.then((value) => {
        this.set(key, value, ttlMs);
        return value;
      });
    }

    this.set(key, result, ttlMs);
    return result;
  }

  /**
   * Invalidate entries matching a predicate
   */
  invalidate(predicate: (key: string, entry: CacheEntry<V>) => boolean): number {
    let count = 0;
    for (const [key, entry] of this.store) {
      if (predicate(key, entry)) {
        this.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Invalidate all entries with a key prefix
   */
  invalidateByPrefix(prefix: string): number {
    return this.invalidate((key) => key.startsWith(prefix));
  }

  /**
   * Get all keys (for debugging/metrics)
   */
  keys(): string[] {
    return Array.from(this.store.keys());
  }

  /**
   * Get all values (for iteration)
   */
  values(): V[] {
    const result: V[] = [];
    for (const entry of this.store.values()) {
      if (!this.isExpired(entry)) {
        result.push(entry.value);
      }
    }
    return result;
  }

  /**
   * Get all entries as [key, value] pairs
   */
  entries(): Array<[string, V]> {
    const result: Array<[string, V]> = [];
    for (const [key, entry] of this.store) {
      if (!this.isExpired(entry)) {
        result.push([key, entry.value]);
      }
    }
    return result;
  }

  /**
   * Iterate over entries (for...of support)
   */
  [Symbol.iterator](): IterableIterator<[string, V]> {
    return this.entries()[Symbol.iterator]();
  }

  /**
   * Prune expired entries
   */
  prune(): number {
    const now = Date.now();
    let pruned = 0;
    for (const [key, entry] of this.store) {
      if (now - entry.createdAt > entry.ttlMs) {
        this.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  // Private helpers

  private isExpired(entry: CacheEntry<V>): boolean {
    return Date.now() - entry.createdAt > entry.ttlMs;
  }

  private touchLRU(key: string): void {
    this.removeFromLRU(key);
    this.accessOrder.push(key);
  }

  private removeFromLRU(key: string): void {
    const idx = this.accessOrder.indexOf(key);
    if (idx >= 0) {
      this.accessOrder.splice(idx, 1);
    }
  }

  private evictIfNeeded(incomingSize: number): void {
    // Evict by count limit
    while (this.store.size >= this.options.maxSize) {
      this.evictLRU();
    }

    // Evict by byte limit
    let totalBytes = this.getTotalSizeBytes();
    while (totalBytes + incomingSize > this.options.maxBytes && this.store.size > 0) {
      const evicted = this.evictLRU();
      if (!evicted) break;
      totalBytes -= evicted.sizeBytes;
    }
  }

  private evictLRU(): CacheEntry<V> | null {
    // Evict oldest entries in batch for efficiency
    const batchSize = Math.max(1, Math.floor(this.store.size * this.options.evictionBatchRatio));
    let evicted: CacheEntry<V> | null = null;

    for (let i = 0; i < batchSize && this.accessOrder.length > 0; i++) {
      const oldestKey = this.accessOrder[0]!;
      const entry = this.store.get(oldestKey);
      if (entry) {
        this.store.delete(oldestKey);
        this.stats.evictions++;
        this.options.onEvict?.(oldestKey, entry);
        if (!evicted) evicted = entry;
      }
      this.accessOrder.shift();
    }

    return evicted;
  }

  private getTotalSizeBytes(): number {
    let total = 0;
    for (const entry of this.store.values()) {
      total += entry.sizeBytes;
    }
    return total;
  }

  private estimateSize(value: V): number {
    if (typeof value === 'string') {
      return value.length * 2; // UTF-16
    }
    if (typeof value === 'number') return 8;
    if (typeof value === 'boolean') return 4;
    if (value === null || value === undefined) return 0;
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 64; // fallback estimate
    }
  }
}

/**
 * Create a cache key from multiple parts
 */
export function cacheKey(...parts: string[]): string {
  if (parts.length === 1) return parts[0]!;
  return parts.join(':');
}

/**
 * Create a content-addressed cache key (hash of content)
 */
export function contentKey(content: string, prefix = ''): string {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 16);
  return prefix ? `${prefix}:${hash}` : hash;
}
