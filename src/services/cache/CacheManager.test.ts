// Tests for CacheManager

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheManager, getCacheManager } from './CacheManager';

describe('CacheManager', () => {
  let manager: CacheManager;

  beforeEach(() => {
    vi.useFakeTimers();
    // Get fresh instance
    CacheManager['instance'] = null;
    manager = CacheManager.getInstance();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe('singleton', () => {
    it('should return same instance', () => {
      const m1 = CacheManager.getInstance();
      const m2 = CacheManager.getInstance();
      expect(m1).toBe(m2);
    });

    it('should return same instance via getCacheManager', () => {
      const m1 = getCacheManager();
      const m2 = getCacheManager();
      expect(m1).toBe(m2);
    });
  });

  describe('getOrCreate', () => {
    it('should create new cache', () => {
      const cache = manager.getOrCreate<string>('test', 'general');
      expect(cache).toBeDefined();
      expect(cache.size).toBe(0);
    });

    it('should return existing cache', () => {
      const cache1 = manager.getOrCreate<string>('test', 'general');
      cache1.set('key', 'value');
      const cache2 = manager.getOrCreate<string>('test', 'general');
      expect(cache2.get('key')).toBe('value');
    });

    it('should apply category defaults', () => {
      const tokenCache = manager.getOrCreate<number>('token', 'token');
      const permissionCache = manager.getOrCreate<number>('perm', 'permission');

      // Token cache should have 2000 maxSize
      tokenCache.set('key', 1);
      expect(tokenCache.getStats().maxSize).toBe(2000);

      // Permission cache should have 500 maxSize
      permissionCache.set('key', 1);
      expect(permissionCache.getStats().maxSize).toBe(500);
    });

    it('should apply overrides', () => {
      const cache = manager.getOrCreate<string>('test', 'general', {
        maxSize: 100,
        defaultTtlMs: 60000,
      });
      cache.set('key', 'value');
      expect(cache.getStats().maxSize).toBe(100);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent cache', () => {
      expect(manager.get('missing')).toBeUndefined();
    });

    it('should return existing cache', () => {
      manager.getOrCreate<string>('test', 'general');
      expect(manager.get('test')).toBeDefined();
    });
  });

  describe('getOrCreatePrefixed', () => {
    it('should create prefixed cache', () => {
      const cache = manager.getOrCreatePrefixed<string>('my-prefix', 'general');
      expect(cache).toBeDefined();
      expect(manager.get('prefixed:my-prefix')).toBe(cache);
    });
  });

  describe('global stats', () => {
    it('should track global hit rate', () => {
      const cache = manager.getOrCreate<string>('test', 'general');
      cache.set('key', 'value');
      cache.get('key'); // hit
      cache.get('key'); // hit
      cache.get('missing'); // miss

      const stats = manager.getGlobalStats();
      expect(stats.totalHits).toBe(2);
      expect(stats.totalMisses).toBe(1);
      expect(stats.globalHitRate).toBeCloseTo(0.667);
    });

    it('should track per-cache stats', () => {
      const cache1 = manager.getOrCreate<string>('cache1', 'general');
      const cache2 = manager.getOrCreate<string>('cache2', 'general');

      cache1.set('key', 'value');
      cache1.get('key');
      cache2.get('missing');

      const stats = manager.getGlobalStats();
      expect(stats.caches['cache1'].hits).toBe(1);
      expect(stats.caches['cache2'].misses).toBe(1);
    });

    it('should generate recommendations', () => {
      const cache = manager.getOrCreate<string>('test', 'general');

      // Generate enough accesses for recommendation
      for (let i = 0; i < 60; i++) {
        cache.set(`key${i}`, 'value');
        cache.get('missing');
      }

      const stats = manager.getGlobalStats();
      expect(stats.recommendations.length).toBeGreaterThan(0);
    });
  });

  describe('getGlobalHitRate', () => {
    it('should return 0 when no caches', () => {
      expect(manager.getGlobalHitRate()).toBe(0);
    });

    it('should calculate global hit rate', () => {
      const cache = manager.getOrCreate<string>('test', 'general');
      cache.set('key', 'value');
      cache.get('key');
      cache.get('key');
      cache.get('missing');

      expect(manager.getGlobalHitRate()).toBeCloseTo(0.667);
    });
  });

  describe('getCategoryHitRates', () => {
    it('should group hit rates by category', () => {
      const tokenCache = manager.getOrCreate<number>('token', 'token');
      const permCache = manager.getOrCreate<number>('perm', 'permission');

      tokenCache.set('key', 1);
      tokenCache.get('key');
      tokenCache.get('key');

      permCache.set('key', 1);
      permCache.get('missing');

      const rates = manager.getCategoryHitRates();
      expect(rates.token.hits).toBe(2);
      expect(rates.token.misses).toBe(0);
      expect(rates.permission.hits).toBe(0);
      expect(rates.permission.misses).toBe(1);
    });
  });

  describe('invalidation', () => {
    it('should invalidate by category', () => {
      const cache1 = manager.getOrCreate<string>('cache1', 'token');
      const cache2 = manager.getOrCreate<string>('cache2', 'permission');
      const cache3 = manager.getOrCreate<string>('cache3', 'token');

      cache1.set('key', 'value');
      cache2.set('key', 'value');
      cache3.set('key', 'value');

      manager.invalidateCategory('token');
      expect(cache1.size).toBe(0);
      expect(cache2.size).toBe(1);
      expect(cache3.size).toBe(0);
    });

    it('should invalidate all caches', () => {
      const cache1 = manager.getOrCreate<string>('cache1', 'general');
      const cache2 = manager.getOrCreate<string>('cache2', 'general');

      cache1.set('key', 'value');
      cache2.set('key', 'value');

      manager.invalidateAll();
      expect(cache1.size).toBe(0);
      expect(cache2.size).toBe(0);
    });
  });

  describe('pruneAll', () => {
    it('should prune expired entries from all caches', () => {
      const cache1 = manager.getOrCreate<string>('cache1', 'general', { defaultTtlMs: 1000 });
      const cache2 = manager.getOrCreate<string>('cache2', 'general', { defaultTtlMs: 1000 });

      cache1.set('key1', 'value1');
      cache2.set('key2', 'value2');

      vi.advanceTimersByTime(1001);

      cache1.set('key3', 'value3');
      const pruned = manager.pruneAll();
      expect(pruned).toBe(2);
    });
  });

  describe('listCaches', () => {
    it('should list all registered cache names', () => {
      manager.getOrCreate<string>('cache1', 'general');
      manager.getOrCreate<string>('cache2', 'general');

      expect(manager.listCaches()).toEqual(['cache1', 'cache2']);
    });
  });

  describe('destroy', () => {
    it('should cleanup intervals and clear caches', () => {
      manager.getOrCreate<string>('test', 'general');
      manager.destroy();

      expect(manager.listCaches()).toEqual([]);
      // Verify prune interval is cleared (no errors after destroy)
    });
  });

});
