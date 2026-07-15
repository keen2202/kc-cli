// Tests for cache metrics collection

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CacheMetricsCollector, globalKVCacheMetrics, withCacheMetrics } from './kvCacheMetrics';

describe('CacheMetricsCollector', () => {
  let collector: CacheMetricsCollector;

  beforeEach(() => {
    collector = new CacheMetricsCollector();
  });

  it('records hits and misses', () => {
    collector.recordHit('test-cache');
    collector.recordHit('test-cache');
    collector.recordMiss('test-cache');

    const metrics = collector.getMetrics('test-cache');
    expect(metrics).not.toBeNull();
    expect(metrics!.hits).toBe(2);
    expect(metrics!.misses).toBe(1);
  });

  it('calculates hit rate', () => {
    collector.recordHit('test-cache');
    collector.recordHit('test-cache');
    collector.recordMiss('test-cache');
    collector.recordMiss('test-cache');

    const metrics = collector.getMetrics('test-cache');
    expect(metrics!.hitRate).toBe(0.5); // 2 hits / 4 total
  });

  it('handles zero operations', () => {
    const metrics = collector.getMetrics('test-cache');
    expect(metrics).toBeNull();
  });

  it('records evictions', () => {
    collector.recordEviction('test-cache');
    collector.recordEviction('test-cache');

    const metrics = collector.getMetrics('test-cache');
    expect(metrics!.evictions).toBe(2);
  });

  it('updates size', () => {
    collector.updateSize('test-cache', 50, 100);

    const metrics = collector.getMetrics('test-cache');
    expect(metrics!.size).toBe(50);
    expect(metrics!.maxSize).toBe(100);
  });

  it('returns null for unknown cache', () => {
    expect(collector.getMetrics('unknown')).toBeNull();
  });

  it('gets all metrics', () => {
    collector.recordHit('cache-1');
    collector.recordMiss('cache-2');

    const allMetrics = collector.getAllMetrics();
    expect(allMetrics.size).toBe(2);
    expect(allMetrics.has('cache-1')).toBe(true);
    expect(allMetrics.has('cache-2')).toBe(true);
  });

  it('gets summary', () => {
    collector.recordHit('cache-1');
    collector.recordHit('cache-1');
    collector.recordMiss('cache-1');
    collector.recordHit('cache-2');
    collector.recordMiss('cache-2');

    const summary = collector.getSummary();
    expect(summary.totalHits).toBe(3);
    expect(summary.totalMisses).toBe(2);
    expect(summary.cacheCount).toBe(2);
  });

  it('calculates average hit rate in summary', () => {
    collector.recordHit('cache-1'); // 100%
    collector.recordHit('cache-2');
    collector.recordMiss('cache-2'); // 50%

    const summary = collector.getSummary();
    expect(summary.averageHitRate).toBe(0.75); // (1.0 + 0.5) / 2
  });

  it('sets alert threshold', () => {
    collector.setAlertThreshold(0.8);
    expect(collector['alertThreshold']).toBe(0.8);
  });

  it('clamps alert threshold to valid range', () => {
    collector.setAlertThreshold(1.5);
    expect(collector['alertThreshold']).toBe(1);

    collector.setAlertThreshold(-0.5);
    expect(collector['alertThreshold']).toBe(0);
  });

  it('triggers alert when hit rate below threshold', () => {
    const alertCallback = vi.fn();
    collector.onAlert(alertCallback);
    collector.setAlertThreshold(0.8);

    // Need at least 10 operations to trigger alert
    for (let i = 0; i < 5; i++) {
      collector.recordHit('test-cache');
    }
    for (let i = 0; i < 5; i++) {
      collector.recordMiss('test-cache');
    }

    expect(alertCallback).toHaveBeenCalledWith('test-cache', 0.5);
  });

  it('does not trigger alert with fewer than 10 operations', () => {
    const alertCallback = vi.fn();
    collector.onAlert(alertCallback);
    collector.setAlertThreshold(0.8);

    collector.recordMiss('test-cache');
    collector.recordMiss('test-cache');

    expect(alertCallback).not.toHaveBeenCalled();
  });

  it('clears cache metrics', () => {
    collector.recordHit('test-cache');
    collector.clearCache('test-cache');

    expect(collector.getMetrics('test-cache')).toBeNull();
  });

  it('clears all metrics', () => {
    collector.recordHit('cache-1');
    collector.recordHit('cache-2');
    collector.clearAll();

    expect(collector.getAllMetrics().size).toBe(0);
  });

  it('exports as JSON', () => {
    collector.recordHit('test-cache');
    collector.updateSize('test-cache', 50, 100);

    const json = collector.exportJSON();
    const parsed = JSON.parse(json);

    expect(parsed['test-cache']).toBeDefined();
    expect(parsed['test-cache'].hits).toBe(1);
    expect(parsed['test-cache'].size).toBe(50);
  });
});

describe('withCacheMetrics', () => {
  let collector: CacheMetricsCollector;
  let innerCache: Map<string, string>;

  beforeEach(() => {
    collector = new CacheMetricsCollector();
    innerCache = new Map();
  });

  it('records hits on get', () => {
    innerCache.set('key', 'value');
    const cache = withCacheMetrics('test', innerCache, collector);

    cache.get('key');

    const metrics = collector.getMetrics('test');
    expect(metrics!.hits).toBe(1);
    expect(metrics!.misses).toBe(0);
  });

  it('records misses on get', () => {
    const cache = withCacheMetrics('test', innerCache, collector);

    cache.get('nonexistent');

    const metrics = collector.getMetrics('test');
    expect(metrics!.hits).toBe(0);
    expect(metrics!.misses).toBe(1);
  });

  it('updates size on set', () => {
    const cache = withCacheMetrics('test', innerCache, collector);

    cache.set('key', 'value');

    const metrics = collector.getMetrics('test');
    expect(metrics!.size).toBe(1);
  });

  it('does not count explicit deletes as evictions', () => {
    innerCache.set('key', 'value');
    const cache = withCacheMetrics('test', innerCache, collector);

    cache.delete('key');

    const metrics = collector.getMetrics('test');
    // Evictions are only counted from the onEvict callback path, not explicit deletes
    expect(metrics!.evictions).toBe(0);
  });

  it('returns correct values', () => {
    innerCache.set('key', 'value');
    const cache = withCacheMetrics('test', innerCache, collector);

    expect(cache.get('key')).toBe('value');
    expect(cache.get('nonexistent')).toBeUndefined();
  });

  it('maintains cache functionality', () => {
    const cache = withCacheMetrics('test', innerCache, collector);

    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    expect(cache.size).toBe(2);

    cache.delete('key1');
    expect(cache.size).toBe(1);

    cache.clear();
    expect(cache.size).toBe(0);
  });
});
