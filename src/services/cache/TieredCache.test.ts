// Tests for TieredCache

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TieredCache, cacheKey, contentKey } from './TieredCache';

describe('TieredCache', () => {
  let cache: TieredCache<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    cache = new TieredCache<string>({ maxSize: 5, defaultTtlMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic operations', () => {
    it('should set and get values', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return undefined for missing keys', () => {
      expect(cache.get('missing')).toBeUndefined();
    });

    it('should check if key exists', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('missing')).toBe(false);
    });

    it('should delete keys', () => {
      cache.set('key1', 'value1');
      expect(cache.delete('key1')).toBe(true);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should return false when deleting non-existent key', () => {
      expect(cache.delete('missing')).toBe(false);
    });

    it('should clear all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.size).toBe(0);
    });

    it('should track size', () => {
      expect(cache.size).toBe(0);
      cache.set('key1', 'value1');
      expect(cache.size).toBe(1);
      cache.set('key2', 'value2');
      expect(cache.size).toBe(2);
    });
  });

  describe('TTL expiration', () => {
    it('should expire entries after TTL', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');

      vi.advanceTimersByTime(1001);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should not expire entries before TTL', () => {
      cache.set('key1', 'value1');
      vi.advanceTimersByTime(999);
      expect(cache.get('key1')).toBe('value1');
    });

    it('should use custom TTL', () => {
      cache.set('key1', 'value1', 2000);
      vi.advanceTimersByTime(1001);
      expect(cache.get('key1')).toBe('value1');

      vi.advanceTimersByTime(1000);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should return false for expired entries in has()', () => {
      cache.set('key1', 'value1');
      vi.advanceTimersByTime(1001);
      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('LRU eviction', () => {
    it('should evict oldest entries when maxSize is reached', () => {
      for (let i = 0; i < 5; i++) {
        cache.set(`key${i}`, `value${i}`);
      }
      expect(cache.size).toBe(5);

      cache.set('key5', 'value5');
      expect(cache.size).toBe(5);
      expect(cache.get('key0')).toBeUndefined();
      expect(cache.get('key5')).toBe('value5');
    });

    it('should update LRU order on get', () => {
      for (let i = 0; i < 5; i++) {
        cache.set(`key${i}`, `value${i}`);
      }

      // Access key0 to make it most recently used
      cache.get('key0');

      // Add new entry, should evict key1 (now oldest)
      cache.set('key5', 'value5');
      expect(cache.get('key0')).toBe('value0');
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should evict in batches', () => {
      const batchCache = new TieredCache<string>({
        maxSize: 10,
        defaultTtlMs: 1000,
        evictionBatchRatio: 0.5,
      });

      for (let i = 0; i < 10; i++) {
        batchCache.set(`key${i}`, `value${i}`);
      }

      batchCache.set('new', 'value');
      // Should evict 50% (5 entries) + 1 new = 6 remaining
      expect(batchCache.size).toBe(6);
    });
  });

  describe('hit rate tracking', () => {
    it('should track hits and misses', () => {
      cache.set('key1', 'value1');
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('missing'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBeCloseTo(0.667);
    });

    it('should return 0 hit rate when no accesses', () => {
      const stats = cache.getStats();
      expect(stats.hitRate).toBe(0);
    });
  });

  describe('getOrSet', () => {
    it('should return cached value if exists', () => {
      cache.set('key1', 'cached');
      const result = cache.getOrSet('key1', () => 'computed');
      expect(result).toBe('cached');
    });

    it('should compute and cache value if missing', () => {
      const result = cache.getOrSet('key1', () => 'computed');
      expect(result).toBe('computed');
      expect(cache.get('key1')).toBe('computed');
    });

    it('should handle async factory', async () => {
      const result = await cache.getOrSet('key1', async () => 'computed');
      expect(result).toBe('computed');
      expect(cache.get('key1')).toBe('computed');
    });
  });

  describe('invalidation', () => {
    it('should invalidate by predicate', () => {
      cache.set('user:1', 'alice');
      cache.set('user:2', 'bob');
      cache.set('post:1', 'hello');

      const count = cache.invalidate((key) => key.startsWith('user:'));
      expect(count).toBe(2);
      expect(cache.get('user:1')).toBeUndefined();
      expect(cache.get('post:1')).toBe('hello');
    });

    it('should invalidate by prefix', () => {
      cache.set('prefix:key1', 'value1');
      cache.set('prefix:key2', 'value2');
      cache.set('other:key3', 'value3');

      const count = cache.invalidateByPrefix('prefix:');
      expect(count).toBe(2);
      expect(cache.get('other:key3')).toBe('value3');
    });
  });

  describe('prune', () => {
    it('should remove expired entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      vi.advanceTimersByTime(1001);

      cache.set('key3', 'value3');
      const pruned = cache.prune();
      expect(pruned).toBe(2);
      expect(cache.size).toBe(1);
    });
  });

  describe('keys and values', () => {
    it('should return all keys', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      expect(cache.keys()).toEqual(['key1', 'key2']);
    });

    it('should return all values', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      expect(cache.values()).toEqual(['value1', 'value2']);
    });

    it('should return all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      expect(cache.entries()).toEqual([
        ['key1', 'value1'],
        ['key2', 'value2'],
      ]);
    });

    it('should support for...of iteration', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      const entries = [];
      for (const [key, value] of cache) {
        entries.push([key, value]);
      }
      expect(entries).toEqual([
        ['key1', 'value1'],
        ['key2', 'value2'],
      ]);
    });
  });

  describe('update existing key', () => {
    it('should update value and move to most recent', () => {
      for (let i = 0; i < 5; i++) {
        cache.set(`key${i}`, `value${i}`);
      }

      // Update key0 - should move to most recent
      cache.set('key0', 'updated');

      // Add new entry, should evict key1 (the oldest)
      cache.set('key5', 'value5');
      expect(cache.get('key0')).toBe('updated');
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key5')).toBe('value5');
    });
  });
});

describe('cacheKey', () => {
  it('should return single key as-is', () => {
    expect(cacheKey('key1')).toBe('key1');
  });

  it('should join multiple keys with colon', () => {
    expect(cacheKey('key1', 'key2', 'key3')).toBe('key1:key2:key3');
  });
});

describe('contentKey', () => {
  it('should create hash of content', () => {
    const key = contentKey('hello world');
    expect(key).toHaveLength(16);
    expect(key).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should create consistent hashes', () => {
    expect(contentKey('hello')).toBe(contentKey('hello'));
    expect(contentKey('hello')).not.toBe(contentKey('world'));
  });

  it('should add prefix', () => {
    const key = contentKey('hello', 'prefix');
    expect(key).toMatch(/^prefix:[0-9a-f]{16}$/);
  });
});
