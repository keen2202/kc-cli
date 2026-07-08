// Tests for CacheMetrics service

import { describe, it, expect, beforeEach } from 'vitest';
import { PromptCacheMetrics, formatCacheMetrics, formatCacheSummary } from './cacheMetrics';

describe('PromptCacheMetrics', () => {
  let metrics: PromptCacheMetrics;

  beforeEach(() => {
    metrics = new PromptCacheMetrics();
  });

  describe('record()', () => {
    it('should record a single call', () => {
      metrics.record('claude-sonnet-4-20250514', 1000, 500, 200);
      const snapshot = metrics.getSnapshot();

      expect(snapshot.callCount).toBe(1);
      expect(snapshot.totalInputTokens).toBe(1000);
      expect(snapshot.cacheReadTokens).toBe(500);
      expect(snapshot.cacheCreationTokens).toBe(200);
    });

    it('should accumulate multiple calls', () => {
      metrics.record('claude-sonnet-4-20250514', 1000, 500, 200);
      metrics.record('claude-sonnet-4-20250514', 1500, 1200, 0);
      const snapshot = metrics.getSnapshot();

      expect(snapshot.callCount).toBe(2);
      expect(snapshot.totalInputTokens).toBe(2500);
      expect(snapshot.cacheReadTokens).toBe(1700);
      expect(snapshot.cacheCreationTokens).toBe(200);
    });

    it('should evict old records beyond maxRecords', () => {
      const smallMetrics = new PromptCacheMetrics(3);
      smallMetrics.record('model', 100, 50, 0);
      smallMetrics.record('model', 200, 100, 0);
      smallMetrics.record('model', 300, 150, 0);
      smallMetrics.record('model', 400, 200, 0); // Should evict first

      const snapshot = smallMetrics.getSnapshot();
      expect(snapshot.callCount).toBe(3);
      expect(snapshot.totalInputTokens).toBe(900); // 200 + 300 + 400
    });
  });

  describe('getSnapshot()', () => {
    it('should return zero values when no records', () => {
      const snapshot = metrics.getSnapshot();

      expect(snapshot.callCount).toBe(0);
      expect(snapshot.totalInputTokens).toBe(0);
      expect(snapshot.hitRate).toBe(0);
      expect(snapshot.estimatedSavingsPercent).toBe(0);
    });

    it('should calculate hit rate correctly', () => {
      metrics.record('model', 1000, 800, 0);
      const snapshot = metrics.getSnapshot();

      expect(snapshot.hitRate).toBeCloseTo(0.8);
    });

    it('should calculate cache miss tokens', () => {
      metrics.record('model', 1000, 500, 200);
      const snapshot = metrics.getSnapshot();

      expect(snapshot.cacheMissTokens).toBe(300); // 1000 - 500 - 200
    });

    it('should estimate savings correctly', () => {
      // 1000 input tokens, 800 from cache → savings ≈ 800 * 0.9 / 1000 = 72%
      metrics.record('model', 1000, 800, 0);
      const snapshot = metrics.getSnapshot();

      expect(snapshot.estimatedSavingsPercent).toBeCloseTo(72);
    });
  });

  describe('getModelSnapshot()', () => {
    it('should filter by model', () => {
      metrics.record('claude-sonnet-4-20250514', 1000, 800, 0);
      metrics.record('claude-3-5-haiku-20241022', 500, 100, 0);

      const sonnetSnap = metrics.getModelSnapshot('claude-sonnet-4-20250514');
      expect(sonnetSnap.callCount).toBe(1);
      expect(sonnetSnap.cacheReadTokens).toBe(800);

      const haikuSnap = metrics.getModelSnapshot('claude-3-5-haiku-20241022');
      expect(haikuSnap.callCount).toBe(1);
      expect(haikuSnap.cacheReadTokens).toBe(100);
    });

    it('should return empty snapshot for unknown model', () => {
      const snapshot = metrics.getModelSnapshot('unknown');
      expect(snapshot.callCount).toBe(0);
    });
  });

  describe('getModelBreakdown()', () => {
    it('should return per-model breakdown', () => {
      metrics.record('model-a', 1000, 500, 0);
      metrics.record('model-b', 2000, 1800, 0);
      metrics.record('model-a', 1500, 1200, 0);

      const breakdown = metrics.getModelBreakdown();
      expect(breakdown.size).toBe(2);
      expect(breakdown.get('model-a')!.callCount).toBe(2);
      expect(breakdown.get('model-b')!.callCount).toBe(1);
    });
  });

  describe('getTrend()', () => {
    it('should calculate trend over window', () => {
      // 5 calls with different hit rates
      metrics.record('model', 1000, 0, 0);    // 0%
      metrics.record('model', 1000, 500, 0);   // 50%
      metrics.record('model', 1000, 800, 0);   // 80%
      metrics.record('model', 1000, 900, 0);   // 90%
      metrics.record('model', 1000, 950, 0);   // 95%

      const trend = metrics.getTrend(5);
      expect(trend.hitRates).toHaveLength(5);
      expect(trend.avgHitRate).toBeCloseTo(0.63); // (0 + 0.5 + 0.8 + 0.9 + 0.95) / 5
    });

    it('should limit to window size', () => {
      for (let i = 0; i < 100; i++) {
        metrics.record('model', 1000, 800, 0);
      }

      const trend = metrics.getTrend(10);
      expect(trend.hitRates).toHaveLength(10);
    });

    it('should return empty for no records', () => {
      const trend = metrics.getTrend();
      expect(trend.hitRates).toHaveLength(0);
      expect(trend.avgHitRate).toBe(0);
    });
  });

  describe('reset()', () => {
    it('should clear all records', () => {
      metrics.record('model', 1000, 500, 0);
      metrics.record('model', 2000, 1000, 0);
      metrics.reset();

      const snapshot = metrics.getSnapshot();
      expect(snapshot.callCount).toBe(0);
    });
  });

  describe('getRecords()', () => {
    it('should return raw records', () => {
      metrics.record('model', 1000, 500, 100);
      const records = metrics.getRecords();

      expect(records).toHaveLength(1);
      expect(records[0].model).toBe('model');
      expect(records[0].inputTokens).toBe(1000);
      expect(records[0].cacheReadTokens).toBe(500);
      expect(records[0].cacheCreationTokens).toBe(100);
      expect(records[0].timestamp).toBeGreaterThan(0);
    });

    it('should return a copy (not mutable reference)', () => {
      metrics.record('model', 1000, 500, 0);
      const records = metrics.getRecords();
      records.pop();

      // Original should be unaffected
      expect(metrics.getRecords()).toHaveLength(1);
    });
  });
});

describe('formatCacheMetrics()', () => {
  it('should format empty snapshot', () => {
    const metrics = new PromptCacheMetrics();
    expect(formatCacheMetrics(metrics.getSnapshot())).toBe('No cache data available');
  });

  it('should format snapshot with data', () => {
    const metrics = new PromptCacheMetrics();
    metrics.record('model', 10000, 8000, 500);

    const formatted = formatCacheMetrics(metrics.getSnapshot());
    expect(formatted).toContain('Hit Rate');
    expect(formatted).toContain('80.0%');
    expect(formatted).toContain('8,000');
    expect(formatted).toContain('API Calls');
    expect(formatted).toContain('1');
  });
});

describe('getProviderBreakdown()', () => {
  it('should group by provider field', () => {
    const metrics = new PromptCacheMetrics();
    metrics.record('deepseek-v4-pro', 1000, 800, 0, 'deepseek');
    metrics.record('claude-sonnet-4-20250514', 1000, 500, 0, 'anthropic');
    metrics.record('deepseek-v4-flash', 500, 400, 0, 'deepseek');

    const breakdown = metrics.getProviderBreakdown();
    expect(breakdown.size).toBe(2);

    const ds = breakdown.get('deepseek')!;
    expect(ds.callCount).toBe(2);
    expect(ds.totalInputTokens).toBe(1500);
    expect(ds.cacheReadTokens).toBe(1200);

    const anth = breakdown.get('anthropic')!;
    expect(anth.callCount).toBe(1);
    expect(anth.cacheReadTokens).toBe(500);
  });

  it('should fallback to model prefix when no provider', () => {
    const metrics = new PromptCacheMetrics();
    metrics.record('gpt-4o', 1000, 500, 0);

    const breakdown = metrics.getProviderBreakdown();
    expect(breakdown.has('gpt-4o')).toBe(true);
  });
});

describe('formatCacheSummary()', () => {
  it('should return empty string for no records', () => {
    const metrics = new PromptCacheMetrics();
    expect(formatCacheSummary(metrics)).toBe('');
  });

  it('should format single provider summary', () => {
    const metrics = new PromptCacheMetrics();
    metrics.record('deepseek-v4-pro', 10000, 8000, 0, 'deepseek');

    const summary = formatCacheSummary(metrics);
    expect(summary).toContain('Cache Performance Summary');
    expect(summary).toContain('Hit Rate');
    expect(summary).not.toContain('Per-Provider');
  });

  it('should include per-provider breakdown for multiple providers', () => {
    const metrics = new PromptCacheMetrics();
    metrics.record('deepseek-v4-pro', 1000, 800, 0, 'deepseek');
    metrics.record('claude-sonnet-4-20250514', 1000, 500, 0, 'anthropic');

    const summary = formatCacheSummary(metrics);
    expect(summary).toContain('Per-Provider Breakdown');
    expect(summary).toContain('deepseek');
    expect(summary).toContain('anthropic');
  });
});
