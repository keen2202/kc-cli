// Memory relevance search - finds most relevant memories for a query

import type { MemoryManifestEntry, MemoryEntry } from './types';

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

  // Calculate relevance scores
  const scored = memories.map((memory) => ({
    fileName: memory.fileName,
    score: calculateRelevanceScore(query, memory, recentTools),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Return top N
  return scored.slice(0, limit).map((s) => s.fileName);
}

/**
 * Calculate relevance score for a memory entry against a query
 */
export function calculateRelevanceScore(
  query: string,
  memory: MemoryManifestEntry,
  recentTools?: string[]
): number {
  let score = 0;

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);
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
  if (recentTools) {
    for (const tool of recentTools) {
      if (description.includes(tool.toLowerCase()) || fileName.includes(tool.toLowerCase())) {
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

  return score;
}

/**
 * Get freshness warning text for a memory file
 * Returns a warning if the memory is stale (>1 day old)
 */
export function getMemoryFreshnessText(mtime: number): string | null {
  const ageDays = (Date.now() - mtime) / (1000 * 60 * 60 * 24);

  if (ageDays < 1) {
    return null; // Fresh, no warning needed
  }

  const ageText = getAgeText(mtime);
  return `(Last updated: ${ageText}. Verify against current state before relying on this information.)`;
}

/**
 * Get human-readable age text
 */
export { getAgeText } from '../utils/format';
