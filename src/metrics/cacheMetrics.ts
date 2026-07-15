import { logger } from '../services/logger';
// Cache monitoring metrics collection

/**
 * Cache metrics data structure.
 */
export interface KVCacheMetrics {
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Number of cache evictions */
  evictions: number;
  /** Current cache size */
  size: number;
  /** Maximum cache size */
  maxSize: number;
  /** Hit rate (hits / (hits + misses)) */
  hitRate: number;
  /** Timestamp of last metrics snapshot */
  timestamp: number;
}

/**
 * Cache metrics collector for monitoring cache performance.
 */
export class CacheMetricsCollector {
  private metrics: Map<string, KVCacheMetrics> = new Map();
  private alertThreshold: number = 0.5; // 50% hit rate threshold
  private alertCallbacks: Array<(cacheName: string, hitRate: number) => void> = [];

  /**
   * Record a cache hit.
   */
  recordHit(cacheName: string): void {
    const metrics = this.getOrCreateMetrics(cacheName);
    metrics.hits++;
    this.updateHitRate(metrics);
    this.checkAlert(cacheName, metrics);
  }

  /**
   * Record multiple cache hits in batch.
   */
  addHits(cacheName: string, count: number): void {
    if (count <= 0) return;
    const metrics = this.getOrCreateMetrics(cacheName);
    metrics.hits += count;
    this.updateHitRate(metrics);
    this.checkAlert(cacheName, metrics);
  }

  /**
   * Record a cache miss.
   */
  recordMiss(cacheName: string): void {
    const metrics = this.getOrCreateMetrics(cacheName);
    metrics.misses++;
    this.updateHitRate(metrics);
    this.checkAlert(cacheName, metrics);
  }

  /**
   * Record multiple cache misses in batch.
   */
  addMisses(cacheName: string, count: number): void {
    if (count <= 0) return;
    const metrics = this.getOrCreateMetrics(cacheName);
    metrics.misses += count;
    this.updateHitRate(metrics);
    this.checkAlert(cacheName, metrics);
  }

  /**
   * Record a cache eviction.
   */
  recordEviction(cacheName: string): void {
    const metrics = this.getOrCreateMetrics(cacheName);
    metrics.evictions++;
  }

  /**
   * Update cache size.
   */
  updateSize(cacheName: string, size: number, maxSize: number): void {
    const metrics = this.getOrCreateMetrics(cacheName);
    metrics.size = size;
    metrics.maxSize = maxSize;
  }

  /**
   * Get metrics for a specific cache.
   */
  getMetrics(cacheName: string): KVCacheMetrics | null {
    return this.metrics.get(cacheName) || null;
  }

  /**
   * Get all cache metrics.
   */
  getAllMetrics(): Map<string, KVCacheMetrics> {
    return new Map(this.metrics);
  }

  /**
   * Get summary of all cache metrics.
   */
  getSummary(): {
    totalHits: number;
    totalMisses: number;
    totalEvictions: number;
    averageHitRate: number;
    cacheCount: number;
  } {
    let totalHits = 0;
    let totalMisses = 0;
    let totalEvictions = 0;
    let totalHitRate = 0;
    let cacheCount = 0;

    for (const metrics of this.metrics.values()) {
      totalHits += metrics.hits;
      totalMisses += metrics.misses;
      totalEvictions += metrics.evictions;
      totalHitRate += metrics.hitRate;
      cacheCount++;
    }

    return {
      totalHits,
      totalMisses,
      totalEvictions,
      averageHitRate: cacheCount > 0 ? totalHitRate / cacheCount : 0,
      cacheCount,
    };
  }

  /**
   * Set alert threshold for hit rate.
   */
  setAlertThreshold(threshold: number): void {
    this.alertThreshold = Math.max(0, Math.min(1, threshold));
  }

  /**
   * Register alert callback.
   */
  onAlert(callback: (cacheName: string, hitRate: number) => void): void {
    this.alertCallbacks.push(callback);
  }

  /**
   * Clear metrics for a specific cache.
   */
  clearCache(cacheName: string): void {
    this.metrics.delete(cacheName);
  }

  /**
   * Clear all metrics.
   */
  clearAll(): void {
    this.metrics.clear();
  }

  /**
   * Export metrics as JSON.
   */
  exportJSON(): string {
    const data: Record<string, KVCacheMetrics> = {};
    for (const [name, metrics] of this.metrics.entries()) {
      data[name] = { ...metrics };
    }
    return JSON.stringify(data, null, 2);
  }

  /**
   * Log metrics summary to console.
   */
  logSummary(): void {
    const summary = this.getSummary();

    logger.services.info('\n=== Cache Metrics Summary ===');
    logger.services.info(`Total Caches: ${summary.cacheCount}`);
    logger.services.info(`Total Hits: ${summary.totalHits}`);
    logger.services.info(`Total Misses: ${summary.totalMisses}`);
    logger.services.info(`Total Evictions: ${summary.totalEvictions}`);
    logger.services.info(`Average Hit Rate: ${(summary.averageHitRate * 100).toFixed(2)}%`);

    if (this.metrics.size > 0) {
      logger.services.info('\nPer-Cache Details:');
      for (const [name, metrics] of this.metrics.entries()) {
        logger.services.info(`  ${name}:`);
        logger.services.info(`    Hits: ${metrics.hits}, Misses: ${metrics.misses}`);
        logger.services.info(`    Hit Rate: ${(metrics.hitRate * 100).toFixed(2)}%`);
        logger.services.info(`    Size: ${metrics.size}/${metrics.maxSize}`);
        logger.services.info(`    Evictions: ${metrics.evictions}`);
      }
    }
    logger.services.info('===========================\n');
  }

  /**
   * Get or create metrics for a cache.
   */
  private getOrCreateMetrics(cacheName: string): KVCacheMetrics {
    let metrics = this.metrics.get(cacheName);
    if (!metrics) {
      metrics = {
        hits: 0,
        misses: 0,
        evictions: 0,
        size: 0,
        maxSize: 0,
        hitRate: 0,
        timestamp: Date.now(),
      };
      this.metrics.set(cacheName, metrics);
    }
    return metrics;
  }

  /**
   * Update hit rate calculation.
   */
  private updateHitRate(metrics: KVCacheMetrics): void {
    const total = metrics.hits + metrics.misses;
    metrics.hitRate = total > 0 ? metrics.hits / total : 0;
    metrics.timestamp = Date.now();
  }

  /**
   * Check if hit rate is below threshold and trigger alert.
   */
  private checkAlert(cacheName: string, metrics: KVCacheMetrics): void {
    const total = metrics.hits + metrics.misses;
    if (total >= 10 && metrics.hitRate < this.alertThreshold) {
      for (const callback of this.alertCallbacks) {
        callback(cacheName, metrics.hitRate);
      }
    }
  }
}

/**
 * Global cache metrics collector instance.
 */
export const globalKVCacheMetrics = new CacheMetricsCollector();

/**
 * Create a cache metrics wrapper for a cache instance.
 * Wraps cache operations to automatically collect metrics.
 */
export function withCacheMetrics<T>(
  cacheName: string,
  cache: {
    get(key: string): T | undefined;
    set(key: string, value: T): void;
    delete(key: string): boolean;
    clear(): void;
    size: number;
  },
  metricsCollector: CacheMetricsCollector = globalKVCacheMetrics
): typeof cache {
  return {
    get(key: string): T | undefined {
      const value = cache.get(key);
      if (value !== undefined) {
        metricsCollector.recordHit(cacheName);
      } else {
        metricsCollector.recordMiss(cacheName);
      }
      return value;
    },

    set(key: string, value: T): void {
      cache.set(key, value);
      metricsCollector.updateSize(cacheName, cache.size, cache.size);
    },

    delete(key: string): boolean {
      const result = cache.delete(key);
      // Note: evictions from explicit delete should NOT be counted as cache evictions.
      // Evictions are only counted via the onEvict callback path from TieredCache.
      metricsCollector.updateSize(cacheName, cache.size, cache.size);
      return result;
    },

    clear(): void {
      cache.clear();
      metricsCollector.updateSize(cacheName, 0, 0);
    },

    get size(): number {
      return cache.size;
    },
  };
}
