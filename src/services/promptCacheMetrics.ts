// Cache Metrics - Track prompt caching effectiveness across API calls

export interface CacheSnapshot {
  /** Total input tokens sent to the API */
  totalInputTokens: number;
  /** Tokens served from cache (cache hits) */
  cacheReadTokens: number;
  /** Tokens written to cache (first-time caching) */
  cacheCreationTokens: number;
  /** Cache hit rate: cacheReadTokens / totalInputTokens */
  hitRate: number;
  /** Tokens that missed cache (input - read - creation) */
  cacheMissTokens: number;
  /** Number of API calls tracked */
  callCount: number;
  /** Estimated cost savings from caching (relative to no caching) */
  estimatedSavingsPercent: number;
}

export interface CacheCallRecord {
  timestamp: number;
  model: string;
  provider?: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/**
 * Tracks prompt cache hit/miss metrics across API calls.
 * Supports Anthropic's prompt caching (cache_read_input_tokens / cache_creation_input_tokens).
 * Can be extended for other providers that expose cache metrics.
 */
export class PromptCacheMetrics {
  private records: CacheCallRecord[] = [];
  private maxRecords: number;

  constructor(maxRecords: number = 500) {
    this.maxRecords = maxRecords;
  }

  /**
   * Record a single API call's cache metrics.
   */
  record(model: string, inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, provider?: string): void {
    this.records.push({
      timestamp: Date.now(),
      model,
      provider,
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
    });

    // Evict old records in-place (avoids array allocation from slice)
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
  }

  /**
   * Get aggregate cache metrics across all recorded calls.
   */
  getSnapshot(): CacheSnapshot {
    let totalInput = 0;
    let totalRead = 0;
    let totalCreation = 0;

    for (const r of this.records) {
      totalInput += r.inputTokens;
      totalRead += r.cacheReadTokens;
      totalCreation += r.cacheCreationTokens;
    }

    const hitRate = totalInput > 0 ? totalRead / totalInput : 0;
    const missTokens = totalInput - totalRead - totalCreation;

    // Anthropic charges ~90% less for cached tokens (read) vs regular input.
    // Savings ≈ cacheReadTokens * 0.9 / totalInput
    const savingsPercent = totalInput > 0 ? (totalRead * 0.9 / totalInput) * 100 : 0;

    return {
      totalInputTokens: totalInput,
      cacheReadTokens: totalRead,
      cacheCreationTokens: totalCreation,
      hitRate,
      cacheMissTokens: Math.max(0, missTokens),
      callCount: this.records.length,
      estimatedSavingsPercent: savingsPercent,
    };
  }

  /**
   * Get cache metrics for a specific model (single-pass instead of filter + iterate).
   */
  getModelSnapshot(model: string): CacheSnapshot {
    let totalInput = 0;
    let totalRead = 0;
    let totalCreation = 0;
    let callCount = 0;

    for (const r of this.records) {
      if (r.model !== model) continue;
      totalInput += r.inputTokens;
      totalRead += r.cacheReadTokens;
      totalCreation += r.cacheCreationTokens;
      callCount++;
    }

    const hitRate = totalInput > 0 ? totalRead / totalInput : 0;
    const missTokens = totalInput - totalRead - totalCreation;
    const savingsPercent = totalInput > 0 ? (totalRead * 0.9 / totalInput) * 100 : 0;

    return {
      totalInputTokens: totalInput,
      cacheReadTokens: totalRead,
      cacheCreationTokens: totalCreation,
      hitRate,
      cacheMissTokens: Math.max(0, missTokens),
      callCount,
      estimatedSavingsPercent: savingsPercent,
    };
  }

  /**
   * Get per-model breakdown of cache metrics.
   */
  getModelBreakdown(): Map<string, CacheSnapshot> {
    const models = new Set(this.records.map(r => r.model));
    const breakdown = new Map<string, CacheSnapshot>();

    for (const model of models) {
      breakdown.set(model, this.getModelSnapshot(model));
    }

    return breakdown;
  }

  /**
   * Get recent cache performance trend (last N calls).
   * Useful for detecting cache degradation after prompt changes.
   */
  getTrend(windowSize: number = 20): { hitRates: number[]; avgHitRate: number } {
    const recent = this.records.slice(-windowSize);
    const hitRates: number[] = [];

    for (const r of recent) {
      const rate = r.inputTokens > 0 ? r.cacheReadTokens / r.inputTokens : 0;
      hitRates.push(rate);
    }

    const avgHitRate = hitRates.length > 0
      ? hitRates.reduce((a, b) => a + b, 0) / hitRates.length
      : 0;

    return { hitRates, avgHitRate };
  }

  /**
   * Get per-provider breakdown of cache metrics.
   * Groups by provider field, falling back to model name prefix.
   */
  getProviderBreakdown(): Map<string, CacheSnapshot> {
    const breakdown = new Map<string, CacheSnapshot>();

    for (const r of this.records) {
      const provider = r.provider || r.model.split('/')[0] || 'unknown';
      const existing = breakdown.get(provider);
      if (existing) {
        // Aggregate inline
        existing.totalInputTokens += r.inputTokens;
        existing.cacheReadTokens += r.cacheReadTokens;
        existing.cacheCreationTokens += r.cacheCreationTokens;
        existing.callCount++;
      } else {
        breakdown.set(provider, {
          totalInputTokens: r.inputTokens,
          cacheReadTokens: r.cacheReadTokens,
          cacheCreationTokens: r.cacheCreationTokens,
          hitRate: 0,
          cacheMissTokens: 0,
          callCount: 1,
          estimatedSavingsPercent: 0,
        });
      }
    }

    // Compute derived metrics
    for (const [, snap] of breakdown) {
      snap.hitRate = snap.totalInputTokens > 0 ? snap.cacheReadTokens / snap.totalInputTokens : 0;
      snap.cacheMissTokens = Math.max(0, snap.totalInputTokens - snap.cacheReadTokens - snap.cacheCreationTokens);
      snap.estimatedSavingsPercent = snap.totalInputTokens > 0 ? (snap.cacheReadTokens * 0.9 / snap.totalInputTokens) * 100 : 0;
    }

    return breakdown;
  }

  /**
   * Reset all recorded metrics.
   */
  reset(): void {
    this.records = [];
  }

  /**
   * Get raw call records (for export/debugging).
   */
  getRecords(): CacheCallRecord[] {
    return [...this.records];
  }
}

/**
 * Format cache metrics snapshot as a human-readable string.
 */
export function formatCacheMetrics(snapshot: CacheSnapshot): string {
  if (snapshot.callCount === 0) {
    return 'No cache data available';
  }

  const lines = [
    `Cache Hit Rate:    ${(snapshot.hitRate * 100).toFixed(1)}%`,
    `Cache Read:        ${snapshot.cacheReadTokens.toLocaleString()} tokens`,
    `Cache Creation:    ${snapshot.cacheCreationTokens.toLocaleString()} tokens`,
    `Cache Miss:        ${snapshot.cacheMissTokens.toLocaleString()} tokens`,
    `Total Input:       ${snapshot.totalInputTokens.toLocaleString()} tokens`,
    `API Calls:         ${snapshot.callCount}`,
    `Est. Savings:      ~${snapshot.estimatedSavingsPercent.toFixed(1)}%`,
  ];

  return lines.join('\n');
}

/**
 * Format a session-end cache summary with per-provider breakdown.
 */
export function formatCacheSummary(metrics: PromptCacheMetrics): string {
  const snapshot = metrics.getSnapshot();
  if (snapshot.callCount === 0) return '';

  const lines = [
    '--- Cache Performance Summary ---',
    formatCacheMetrics(snapshot),
  ];

  const breakdown = metrics.getProviderBreakdown();
  if (breakdown.size > 1) {
    lines.push('');
    lines.push('Per-Provider Breakdown:');
    for (const [provider, snap] of breakdown) {
      const rate = (snap.hitRate * 100).toFixed(1);
      lines.push(`  ${provider}: ${rate}% hit rate, ${snap.callCount} calls, ~${snap.estimatedSavingsPercent.toFixed(1)}% savings`);
    }
  }

  lines.push('---------------------------------');
  return lines.join('\n');
}
