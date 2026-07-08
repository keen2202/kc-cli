// CacheManager - Global cache coordinator
// Manages all TieredCache instances, provides unified metrics and adaptive tuning

import { TieredCache, type CacheStats, type TieredCacheOptions } from './TieredCache';
import { globalKVCacheMetrics } from '../../metrics/cacheMetrics';

export type CacheCategory =
  | 'token'       // Token estimation cache
  | 'permission'  // Permission rule/regex cache
  | 'memory'      // Memory relevance scores
  | 'capability'  // Provider capabilities
  | 'lsp'         // LSP diagnostics
  | 'tool'        // Tool execution results
  | 'prompt'      // Prompt prefix cache
  | 'session'     // Session data
  | 'general';    // General purpose

export interface GlobalCacheStats {
  totalHits: number;
  totalMisses: number;
  globalHitRate: number;
  caches: Record<string, CacheStats>;
  recommendations: string[];
}

interface CacheRegistration {
  name: string;
  category: CacheCategory;
  cache: TieredCache;
}

// Adaptive TTL based on access patterns
const BASE_TTL: Record<CacheCategory, number> = {
  token: 10 * 60 * 1000,      // 10 min - tokens are expensive to compute
  permission: 30 * 60 * 1000,  // 30 min - rules rarely change
  memory: 5 * 60 * 1000,       // 5 min - memories can be updated
  capability: 60 * 60 * 1000,  // 1 hour - capabilities are static
  lsp: 2 * 60 * 1000,          // 2 min - diagnostics change frequently
  tool: 5 * 60 * 1000,         // 5 min - tool results
  prompt: 30 * 60 * 1000,      // 30 min - prompt prefixes are stable
  session: 60 * 60 * 1000,     // 1 hour - session data
  general: 5 * 60 * 1000,      // 5 min default
};

// Adaptive size limits based on category
const BASE_MAX_SIZE: Record<CacheCategory, number> = {
  token: 2000,
  permission: 500,
  memory: 1000,
  capability: 50,
  lsp: 500,
  tool: 200,
  prompt: 100,
  session: 100,
  general: 500,
};

export class CacheManager {
  private static instance: CacheManager | null = null;
  private caches = new Map<string, CacheRegistration>();
  private pruneInterval: NodeJS.Timeout | null = null;

  private constructor() {
    // Prune expired entries every 60 seconds
    this.pruneInterval = setInterval(() => this.pruneAll(), 60_000);
    // Don't prevent process exit
    if (this.pruneInterval.unref) {
      this.pruneInterval.unref();
    }
  }

  static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  /**
   * Create or get a named cache with category-based defaults.
   * Automatically records metrics via globalKVCacheMetrics.
   */
  getOrCreate<V>(
    name: string,
    category: CacheCategory = 'general',
    overrides: Partial<TieredCacheOptions> = {}
  ): TieredCache<V> {
    const existing = this.caches.get(name);
    if (existing) {
      // Record metrics for cache access
      const stats = existing.cache.getStats();
      globalKVCacheMetrics.updateSize(name, stats.size, stats.maxSize);
      return existing.cache as TieredCache<V>;
    }

    const baseTtl = BASE_TTL[category];
    const maxSize = overrides.maxSize ?? BASE_MAX_SIZE[category];

    const cache = new TieredCache<V>({
      maxSize,
      maxBytes: overrides.maxBytes ?? (maxSize * 4096), // ~4KB per entry average
      defaultTtlMs: overrides.defaultTtlMs ?? baseTtl,
      evictionBatchRatio: overrides.evictionBatchRatio ?? 0.25,
      onEvict: overrides.onEvict,
    });

    this.caches.set(name, { name, category, cache });

    // Initialize metrics for this cache
    globalKVCacheMetrics.updateSize(name, 0, maxSize);

    return cache;
  }

  /**
   * Get an existing cache by name
   */
  get<V>(name: string): TieredCache<V> | undefined {
    return this.caches.get(name)?.cache as TieredCache<V> | undefined;
  }

  /**
   * Get or create with a specific key prefix for namespacing
   */
  getOrCreatePrefixed<V>(
    prefix: string,
    category: CacheCategory = 'general'
  ): TieredCache<V> {
    return this.getOrCreate<V>(`prefixed:${prefix}`, category);
  }

  /**
   * Get global cache statistics. Also syncs metrics to globalKVCacheMetrics.
   */
  getGlobalStats(): GlobalCacheStats {
    let totalHits = 0;
    let totalMisses = 0;
    const cacheStats: Record<string, CacheStats> = {};

    for (const [name, reg] of this.caches) {
      const stats = reg.cache.getStats();
      cacheStats[name] = stats;
      totalHits += stats.hits;
      totalMisses += stats.misses;

      // Sync to global cache metrics
      globalKVCacheMetrics.updateSize(name, stats.size, stats.maxSize);
    }

    const globalHitRate = totalHits + totalMisses > 0
      ? totalHits / (totalHits + totalMisses)
      : 0;

    return {
      totalHits,
      totalMisses,
      globalHitRate,
      caches: cacheStats,
      recommendations: this.generateRecommendations(cacheStats),
    };
  }

  /**
   * Sync current cache stats to the global metrics collector.
   * Call periodically or before reporting.
   */
  syncMetrics(): void {
    for (const [name, reg] of this.caches) {
      const stats = reg.cache.getStats();
      // Record hits and misses based on stats diff
      const existing = globalKVCacheMetrics.getMetrics(name);
      const prevHits = existing?.hits ?? 0;
      const prevMisses = existing?.misses ?? 0;

      const newHits = stats.hits - prevHits;
      const newMisses = stats.misses - prevMisses;

      for (let i = 0; i < newHits; i++) globalKVCacheMetrics.recordHit(name);
      for (let i = 0; i < newMisses; i++) globalKVCacheMetrics.recordMiss(name);
      for (let i = 0; i < stats.evictions - (existing?.evictions ?? 0); i++) {
        globalKVCacheMetrics.recordEviction(name);
      }

      globalKVCacheMetrics.updateSize(name, stats.size, stats.maxSize);
    }
  }

  /**
   * Get the global cache metrics collector for external reporting.
   */
  getMetricsCollector() {
    return globalKVCacheMetrics;
  }

  /**
   * Get global hit rate (the primary metric)
   */
  getGlobalHitRate(): number {
    let totalHits = 0;
    let totalMisses = 0;
    for (const reg of this.caches.values()) {
      const stats = reg.cache.getStats();
      totalHits += stats.hits;
      totalMisses += stats.misses;
    }
    return totalHits + totalMisses > 0 ? totalHits / (totalHits + totalMisses) : 0;
  }

  /**
   * Get per-category hit rates
   */
  getCategoryHitRates(): Record<CacheCategory, { hits: number; misses: number; hitRate: number }> {
    const categories = new Map<CacheCategory, { hits: number; misses: number }>();

    for (const reg of this.caches.values()) {
      const stats = reg.cache.getStats();
      const existing = categories.get(reg.category);
      if (existing) {
        existing.hits += stats.hits;
        existing.misses += stats.misses;
      } else {
        categories.set(reg.category, { hits: stats.hits, misses: stats.misses });
      }
    }

    const result: Record<string, { hits: number; misses: number; hitRate: number }> = {};
    for (const [cat, data] of categories) {
      const total = data.hits + data.misses;
      result[cat] = {
        hits: data.hits,
        misses: data.misses,
        hitRate: total > 0 ? data.hits / total : 0,
      };
    }
    return result as Record<CacheCategory, { hits: number; misses: number; hitRate: number }>;
  }

  /**
   * Invalidate entries across all caches matching a category
   */
  invalidateCategory(category: CacheCategory): number {
    let total = 0;
    for (const reg of this.caches.values()) {
      if (reg.category === category) {
        reg.cache.clear();
        total++;
      }
    }
    return total;
  }

  /**
   * Invalidate all caches
   */
  invalidateAll(): void {
    for (const reg of this.caches.values()) {
      reg.cache.clear();
    }
  }

  /**
   * Prune expired entries across all caches
   */
  pruneAll(): number {
    let totalPruned = 0;
    for (const reg of this.caches.values()) {
      totalPruned += reg.cache.prune();
    }
    return totalPruned;
  }

  /**
   * List all registered cache names
   */
  listCaches(): string[] {
    return Array.from(this.caches.keys());
  }

  /**
   * Destroy the cache manager (cleanup intervals)
   */
  destroy(): void {
    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }
    this.caches.clear();
    CacheManager.instance = null;
  }

  // Private

  private generateRecommendations(stats: Record<string, CacheStats>): string[] {
    const recommendations: string[] = [];

    for (const [name, stat] of Object.entries(stats)) {
      if (stat.hits + stat.misses < 10) continue; // Not enough data

      if (stat.hitRate < 0.5) {
        recommendations.push(
          `Cache "${name}" has low hit rate (${(stat.hitRate * 100).toFixed(1)}%). Consider increasing TTL or cache size.`
        );
      }

      if (stat.evictions > stat.hits * 0.5) {
        recommendations.push(
          `Cache "${name}" has high eviction rate. Consider increasing maxSize (currently ${stat.maxSize}).`
        );
      }

      if (stat.totalSizeBytes > stat.maxSizeBytes * 0.9) {
        recommendations.push(
          `Cache "${name}" is near capacity (${(stat.totalSizeBytes / 1024).toFixed(0)}KB / ${(stat.maxSizeBytes / 1024).toFixed(0)}KB).`
        );
      }
    }

    return recommendations;
  }
}

/**
 * Convenience: get the global CacheManager instance.
 * Checks the ServiceContainer first (enables test-time replacement),
 * falling back to the class-level singleton.
 */
export function getCacheManager(): CacheManager {
  try {
    const { getServiceContainer } = require('../../services/ServiceContainer');
    const container = getServiceContainer();
    if (container.has('cacheManager')) {
      return container.resolve('cacheManager') as CacheManager;
    }
  } catch {
    // ServiceContainer not available — use direct singleton
  }
  return CacheManager.getInstance();
}
