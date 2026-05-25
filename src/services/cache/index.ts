// Cache system - unified exports

export { TieredCache, cacheKey, contentKey, type CacheEntry, type CacheStats, type TieredCacheOptions } from './TieredCache';
export { CacheManager, getCacheManager, type CacheCategory, type GlobalCacheStats } from './CacheManager';
export { stableHash } from './compression';
export { CacheConsistencyManager, getConsistencyManager } from './consistency';

/**
 * Format a human-readable cache dashboard showing all cache hit rates
 */
export function formatCacheDashboard(): string {
  const { getCacheManager } = require('./CacheManager');
  const manager = getCacheManager();
  const stats = manager.getGlobalStats();
  const categoryRates = manager.getCategoryHitRates();

  const lines: string[] = [
    '╔══════════════════════════════════════════════════════════╗',
    '║                   Cache Performance Dashboard            ║',
    '╠══════════════════════════════════════════════════════════╣',
    `║ Global Hit Rate: ${(stats.globalHitRate * 100).toFixed(1).padStart(6)}%  (${stats.totalHits} hits / ${stats.totalMisses} misses) ║`,
    '╠══════════════════════════════════════════════════════════╣',
    '║ Category Breakdown:                                      ║',
  ];

  for (const [cat, data] of Object.entries(categoryRates)) {
    const d = data as { hitRate: number; hits: number; misses: number };
    const rate = (d.hitRate * 100).toFixed(1).padStart(6);
    const bar = d.hitRate >= 0.9 ? '████' : d.hitRate >= 0.7 ? '███░' : d.hitRate >= 0.5 ? '██░░' : '█░░░';
    lines.push(`║   ${cat.padEnd(12)} ${bar} ${rate}%  (${d.hits}h/${d.misses}m) ║`);
  }

  lines.push('╠══════════════════════════════════════════════════════════╣');
  lines.push('║ Per-Cache Details:                                       ║');

  for (const [name, cacheStats] of Object.entries(stats.caches)) {
    const cs = cacheStats as { hitRate: number; size: number; maxSize: number };
    const rate = (cs.hitRate * 100).toFixed(1).padStart(6);
    const size = `${cs.size}/${cs.maxSize}`.padStart(8);
    lines.push(`║   ${name.padEnd(20)} ${rate}% ${size} ║`);
  }

  if (stats.recommendations.length > 0) {
    lines.push('╠══════════════════════════════════════════════════════════╣');
    lines.push('║ Recommendations:                                         ║');
    for (const rec of stats.recommendations) {
      lines.push(`║   • ${rec.substring(0, 52).padEnd(52)} ║`);
    }
  }

  lines.push('╚══════════════════════════════════════════════════════════╝');
  return lines.join('\n');
}
