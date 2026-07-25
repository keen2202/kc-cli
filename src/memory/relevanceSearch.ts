// Memory relevance search - finds most relevant memories for a query

import type { MemoryManifestEntry, MemoryEntry } from './types';
import { getAgeText } from '../utils/format';
import { getCacheManager } from '../services/cache';
import { tokenize } from '../utils/tokenize';

// Feedback tracking: maps memory fileName to reference count, bounded by LRU cache
const feedbackMap = getCacheManager().getOrCreate<{ loaded: number; referenced: number }>(
  'memory-feedback',
  'memory',
  { maxSize: 2000, defaultTtlMs: 24 * 60 * 60 * 1000 }
);

// Score cache with TieredCache for LRU eviction and hit rate tracking
const scoreCache = getCacheManager().getOrCreate<number>('memory-relevance', 'memory', { maxSize: 1000 });

// Configurable stale threshold (default 30 days)
let staleThresholdDays = 30;

/**
 * Optional semantic scorer extension point (H2).
 * Returning `undefined` falls back to the keyword/token-overlap path.
 * No embedding implementation is shipped in this phase; this is the seam for one.
 */
export interface SemanticScorer {
  score(query: string, entry: MemoryManifestEntry): number | undefined;
}

let semanticScorer: SemanticScorer | undefined;

/** Register (or clear) the optional semantic scorer. */
export function setSemanticScorer(scorer: SemanticScorer | undefined): void {
  semanticScorer = scorer;
}

/** Stable, order-/case-independent signature of a query's token set (cache key). */
function querySignatureOf(tokens: string[]): string {
  return [...tokens].sort().join('\u0001');
}

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

  // Pre-compute query tokens once (shared across all memories).
  // Uses the CJK-aware tokenizer so Chinese/Japanese/Korean queries retrieve too.
  const queryLower = query.toLowerCase();
  const queryTokens = tokenize(query);
  const recentToolsLower = recentTools?.map(t => t.toLowerCase());

  // Calculate relevance scores (using internal function to avoid re-computing query tokens)
  const scored = memories.map((memory) => ({
    fileName: memory.fileName,
    score: calculateRelevanceScoreInner(queryLower, queryTokens, memory, recentToolsLower),
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
  // Support both old signature (query, memory, recentTools) and new (queryLower, queryTokens, memory, recentToolsLower)
  let queryLower: string;
  let queryTokens: string[];
  let memory: MemoryManifestEntry;
  let recentToolsLower: string[] | undefined;

  if (Array.isArray(memoryOrWords)) {
    // New signature: (queryLower, queryTokens, memory, recentToolsLower)
    queryLower = queryOrLower;
    queryTokens = memoryOrWords;
    memory = memoryOrRecent as MemoryManifestEntry;
    recentToolsLower = recentToolsOrUndefined;
  } else {
    // Old signature: (query, memory, recentTools)
    queryLower = queryOrLower.toLowerCase();
    queryTokens = tokenize(queryOrLower);
    memory = memoryOrWords;
    recentToolsLower = (memoryOrRecent as string[] | undefined)?.map(t => t.toLowerCase());
  }

  return calculateRelevanceScoreInner(queryLower, queryTokens, memory, recentToolsLower);
}

/**
 * Internal relevance score calculation with pre-computed values.
 * Combines exact-substring match (high weight), per-token description/filename
 * matches, and a token-overlap ratio bonus (CJK-aware), then applies type,
 * recency, feedback and confidence multipliers.
 */
function calculateRelevanceScoreInner(
  queryLower: string,
  queryTokens: string[],
  memory: MemoryManifestEntry,
  recentToolsLower?: string[]
): number {
  // Cache key uses a normalized token signature so case/word-order variants
  // of the same query share cache entries (avoids cache churn).
  const cacheKey = `${querySignatureOf(queryTokens)}:${memory.fileName}`;
  const cached = scoreCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let score = 0;

  const description = memory.description.toLowerCase();
  const fileName = memory.fileName.toLowerCase();
  const descTokens = new Set(tokenize(memory.description));
  const fileTokens = new Set(tokenize(memory.fileName));

  // Exact match in description (high weight)
  if (queryLower && description.includes(queryLower)) {
    score += 50;
  }

  // Per-token matches in description
  for (const token of queryTokens) {
    if (description.includes(token)) {
      score += 10;
    }
  }

  // Per-token matches in file name
  for (const token of queryTokens) {
    if (fileName.includes(token)) {
      score += 15;
    }
  }

  // Token-overlap ratio bonus: rewards higher query coverage (CJK-aware).
  if (queryTokens.length > 0) {
    let matched = 0;
    for (const token of queryTokens) {
      if (descTokens.has(token) || fileTokens.has(token)) matched++;
    }
    if (matched > 0) {
      score += Math.round((matched / queryTokens.length) * 20);
    }
  }

  // Optional semantic signal (extension point; no-op by default)
  if (semanticScorer) {
    const sem = semanticScorer.score(queryLower, memory);
    if (sem !== undefined) {
      score += sem;
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
  semanticScorer = undefined;
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
 * Get the current feedback map size (for testing)
 */
export function getFeedbackMapSize(): number {
  return feedbackMap.size;
}

/**
 * Token-set similarity in [0, 1] for semantic dedup (T4 / GR4).
 *
 * Reuses the shared CJK-aware {@link tokenize} (same tokenizer the relevance
 * scorer uses) and returns the overlap coefficient — intersection size over the
 * smaller token set. This favours detecting a paraphrase that is largely
 * contained in an existing memory, without introducing an embedding dependency.
 * Pure & deterministic.
 */
export function tokenSetSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection++;
  }
  return intersection / small.size;
}

/**
 * Get human-readable age text
 */
export { getAgeText } from '../utils/format';
