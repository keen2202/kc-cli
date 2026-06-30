// Memory relevance search - finds most relevant memories for a query

import type { MemoryManifestEntry, MemoryEntry } from './types';
import { getAgeText } from '../utils/format';
import { getCacheManager } from '../services/cache';

// Feedback tracking: maps memory fileName to reference count
const feedbackMap = new Map<string, { loaded: number; referenced: number }>();

// Score cache with TieredCache for LRU eviction and hit rate tracking
const scoreCache = getCacheManager().getOrCreate<number>('memory-relevance', 'memory', { maxSize: 1000 });

// Configurable stale threshold (default 30 days)
let staleThresholdDays = 30;

/**
 * Find relevant memories using heuristic keyword matching
 * Returns up to `limit` most relevant memory file names
 */
export function findRelevantMemories(
  query: string,
  memories: MemoryManifestEntry[],
  recentTools?: string[],
  limit: number = 5
): string[] {
  if (memories.length === 0) return [];

  // Pre-compute query words once (shared across all memories)
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);
  const recentToolsLower = recentTools?.map(t => t.toLowerCase());

  // Calculate relevance scores (using internal function to avoid re-computing query words)
  const scored = memories.map((memory) => ({
    fileName: memory.fileName,
    score: calculateRelevanceScoreInner(queryLower, queryWords, memory, recentToolsLower),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return top N
  const result = scored.slice(0, limit).map((s) => s.fileName);

  // Track loaded memories for feedback
  for (const fileName of result) {
    const entry = feedbackMap.get(fileName) || { loaded: 0, referenced: 0 };
    entry.loaded++;
    feedbackMap.set(fileName, entry);
  }

  return result;
}

/**
 * Mark memories as referenced in the conversation (feedback signal)
 * Call this when the assistant's response clearly uses information from a memory
 */
export function markMemoriesReferenced(fileNames: string[]): void {
  for (const fileName of fileNames) {
    const entry = feedbackMap.get(fileName) || { loaded: 0, referenced: 0 };
    entry.referenced++;
    feedbackMap.set(fileName, entry);
  }
  invalidateScoreCache();
}

/**
 * Get feedback score adjustment for a memory
 * Returns a multiplier: referenced memories get a boost, unreferenced get a penalty
 */
function getFeedbackMultiplier(fileName: string): number {
  const entry = feedbackMap.get(fileName);
  if (!entry || entry.loaded === 0) return 1.0;

  const referenceRate = entry.referenced / entry.loaded;

  // High reference rate → boost, low reference rate → penalty
  if (referenceRate >= 0.7) return 1.3;  // Frequently referenced: 30% boost
  if (referenceRate >= 0.3) return 1.0;  // Sometimes referenced: neutral
  if (entry.loaded >= 3) return 0.7;     // Loaded 3+ times but rarely referenced: 30% penalty
  return 1.0;
}

/**
 * Calculate relevance score for a memory entry against a query.
 * Accepts either raw query string or pre-computed values.
 */
export function calculateRelevanceScore(
  queryOrLower: string,
  memoryOrWords: MemoryManifestEntry | string[],
  memoryOrRecent?: MemoryManifestEntry | string[],
  recentToolsOrUndefined?: string[]
): number {
  // Support both old signature (query, memory, recentTools) and new (queryLower, queryWords, memory, recentToolsLower)
  let queryLower: string;
  let queryWords: string[];
  let memory: MemoryManifestEntry;
  let recentToolsLower: string[] | undefined;

  if (Array.isArray(memoryOrWords)) {
    // New signature: (queryLower, queryWords, memory, recentToolsLower)
    queryLower = queryOrLower;
    queryWords = memoryOrWords;
    memory = memoryOrRecent as MemoryManifestEntry;
    recentToolsLower = recentToolsOrUndefined;
  } else {
    // Old signature: (query, memory, recentTools)
    queryLower = queryOrLower.toLowerCase();
    queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);
    memory = memoryOrWords;
    recentToolsLower = (memoryOrRecent as string[] | undefined)?.map(t => t.toLowerCase());
  }

  return calculateRelevanceScoreInner(queryLower, queryWords, memory, recentToolsLower);
}

/**
 * Internal relevance score calculation with pre-computed values.
 */
function calculateRelevanceScoreInner(
  queryLower: string,
  queryWords: string[],
  memory: MemoryManifestEntry,
  recentToolsLower?: string[]
): number {
  // Check cache first
  const cacheKey = `${queryLower}:${memory.fileName}`;
  const cached = scoreCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let score = 0;

  const description = memory.description.toLowerCase();
  const fileName = memory.fileName.toLowerCase();

  // Exact match in description (high weight)
  if (description.includes(queryLower)) {
    score += 50;
  }

  // Word matches in description
  for (const word of queryWords) {
    if (description.includes(word)) {
      score += 10;
    }
  }

  // File name matches
  for (const word of queryWords) {
    if (fileName.includes(word)) {
      score += 15;
    }
  }

  // Type relevance boost
  if (queryLower.includes('preference') || queryLower.includes('user')) {
    if (memory.type === 'user') score += 20;
  }
  if (queryLower.includes('feedback') || queryLower.includes('lesson') || queryLower.includes('avoid')) {
    if (memory.type === 'feedback') score += 20;
  }
  if (queryLower.includes('project') || queryLower.includes('decision') || queryLower.includes('goal')) {
    if (memory.type === 'project') score += 20;
  }
  if (queryLower.includes('link') || queryLower.includes('reference') || queryLower.includes('doc')) {
    if (memory.type === 'reference') score += 20;
  }

  // Recent tools boost (if memory relates to recently used tools)
  if (recentToolsLower) {
    for (const tool of recentToolsLower) {
      if (description.includes(tool) || fileName.includes(tool)) {
        score += 10;
      }
    }
  }

  // Recency boost (newer memories slightly preferred)
  const ageDays = (Date.now() - memory.mtime) / (1000 * 60 * 60 * 24);
  if (ageDays < 1) {
    score += 5; // Created today
  } else if (ageDays < 7) {
    score += 3; // Within a week
  } else if (ageDays < 30) {
    score += 1; // Within a month
  }

  // Apply feedback multiplier
  score *= getFeedbackMultiplier(memory.fileName);

  // Apply confidence multiplier
  if (memory.confidence === 'high') {
    score *= 1.2;
  } else if (memory.confidence === 'low') {
    score *= 0.8;
  }

  // Cache the score
  scoreCache.set(cacheKey, score);

  return score;
}

/**
 * Get freshness warning text for a memory file
 * Returns a warning if the memory is stale (older than staleThresholdDays)
 */
export function getMemoryFreshnessText(mtime: number): string | null {
  const ageDays = (Date.now() - mtime) / (1000 * 60 * 60 * 24);

  if (ageDays < staleThresholdDays) {
    return null; // Fresh enough, no warning needed
  }

  const ageText = getAgeText(mtime);
  return `(Last updated: ${ageText}. Verify against current state before relying on this information.)`;
}

/**
 * Set the stale threshold in days
 */
export function setStaleThreshold(days: number): void {
  staleThresholdDays = days;
}

/**
 * Get the current stale threshold in days
 */
export function getStaleThreshold(): number {
  return staleThresholdDays;
}

/**
 * Invalidate score cache (call when new memories are written)
 */
export function invalidateScoreCache(): void {
  scoreCache.clear();
}

/**
 * Reset all adaptive state (for testing)
 */
export function resetRelevanceState(): void {
  feedbackMap.clear();
  scoreCache.clear();
  staleThresholdDays = 30;
}

/**
 * Get score cache hit rate for monitoring
 */
export function getScoreCacheHitRate(): number {
  const stats = scoreCache.getStats();
  return stats.hitRate;
}

/**
 * Get feedback stats for a memory (for testing/debugging)
 */
export function getFeedbackStats(fileName: string): { loaded: number; referenced: number } | null {
  return feedbackMap.get(fileName) || null;
}

/**
 * Get human-readable age text
 */
export { getAgeText } from '../utils/format';
