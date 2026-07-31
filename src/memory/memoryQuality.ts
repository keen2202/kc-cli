// Memory quality pipeline - validation, coherence checks, and pruning

import type { MemoryEntry, MemoryManifestEntry } from './types';

// Quality thresholds
const MIN_CONTENT_LENGTH = 20;
const CODE_BLOCK_RATIO_THRESHOLD = 0.5;
const MIN_MERGED_COHERENCE_SCORE = 0.3;
const DEFAULT_PRUNE_AFTER_SESSIONS = 5;

export interface QualityCheckResult {
  pass: boolean;
  reason?: 'too_short' | 'code_only' | 'duplicate' | 'incoherent';
  details?: string;
}

export interface PruneConfig {
  /** Number of sessions a memory must be loaded but never referenced before pruning */
  sessionsThreshold: number;
  /** Minimum age in days before a memory becomes eligible for pruning */
  minAgeDays: number;
}

const DEFAULT_PRUNE_CONFIG: PruneConfig = {
  sessionsThreshold: DEFAULT_PRUNE_AFTER_SESSIONS,
  minAgeDays: 7,
};

/**
 * Validate extracted memory content quality
 */
export function validateExtractedMemory(content: string): QualityCheckResult {
  const trimmed = content.trim();

  // Minimum length check
  if (trimmed.length < MIN_CONTENT_LENGTH) {
    return { pass: false, reason: 'too_short', details: `Content is ${trimmed.length} chars, minimum is ${MIN_CONTENT_LENGTH}` };
  }

  // Code-only content check
  const codeBlockMatches = trimmed.match(/```[\s\S]*?```/g) || [];
  const codeBlockLength = codeBlockMatches.reduce((sum, block) => sum + block.length, 0);
  if (trimmed.length > 0 && codeBlockLength / trimmed.length > CODE_BLOCK_RATIO_THRESHOLD) {
    return { pass: false, reason: 'code_only', details: `Code blocks are ${Math.round(codeBlockLength / trimmed.length * 100)}% of content` };
  }

  return { pass: true };
}

/**
 * Validate that a merged memory is coherent (not contradictory fragments)
 * Checks for common signs of incoherent merging:
 * - Contradictory statements (e.g., "use X" and "don't use X")
 * - Excessive fragmentation (too many unrelated topics)
 */
export function validateMergedCoherence(content: string): QualityCheckResult {
  const lines = content.split('\n').filter(l => l.trim().length > 0);

  if (lines.length === 0) {
    return { pass: false, reason: 'incoherent', details: 'Empty content after merge' };
  }

  // Check for contradictory patterns in the same paragraph
  const lowerContent = content.toLowerCase();

  // Simple contradiction detection
  const contradictionPairs = [
    ['use ', "don't use "],
    ['prefer ', "don't prefer "],
    ['always ', 'never '],
    ['should ', "shouldn't "],
    ['enable ', 'disable '],
  ];

  for (const [positive, negative] of contradictionPairs) {
    const posIndex = lowerContent.indexOf(positive);
    const negIndex = lowerContent.indexOf(negative);

    // If both exist and are close together (within 200 chars), flag as potential contradiction
    if (posIndex !== -1 && negIndex !== -1 && Math.abs(posIndex - negIndex) < 200) {
      return {
        pass: false,
        reason: 'incoherent',
        details: `Potential contradiction detected: "${positive}" and "${negative}" found close together`,
      };
    }
  }

  return { pass: true };
}

/**
 * Check if a memory should be pruned based on retrieval feedback
 * A memory should be pruned if:
 * - It has been loaded >= sessionsThreshold times
 * - It has never been referenced (referenced === 0)
 * - It is older than minAgeDays
 */
export function shouldPruneMemory(
  memory: MemoryManifestEntry,
  feedback: { loaded: number; referenced: number } | null,
  config: PruneConfig = DEFAULT_PRUNE_CONFIG
): boolean {
  if (!feedback) return false;

  // Not old enough to prune
  const ageDays = (Date.now() - memory.mtime) / (1000 * 60 * 60 * 24);
  if (ageDays < config.minAgeDays) return false;

  // Loaded enough times but never referenced
  if (feedback.loaded >= config.sessionsThreshold && feedback.referenced === 0) {
    return true;
  }

  return false;
}

/**
 * Filter memories that should be pruned
 * Returns file names of memories to prune
 */
export function getMemoriesToPrune(
  memories: MemoryManifestEntry[],
  feedbackMap: Map<string, { loaded: number; referenced: number }>,
  config: PruneConfig = DEFAULT_PRUNE_CONFIG
): string[] {
  // Single-pass: filter + map combined into flatMap
  return memories.flatMap(memory => {
    const feedback = feedbackMap.get(memory.fileName) || null;
    return shouldPruneMemory(memory, feedback, config) ? [memory.fileName] : [];
  });
}

/**
 * Run quality pipeline on a batch of extracted memories
 * Returns only memories that pass all quality checks
 */
export function filterQualityMemories(memories: MemoryEntry[]): {
  passed: MemoryEntry[];
  rejected: { memory: MemoryEntry; reason: string }[];
} {
  const passed: MemoryEntry[] = [];
  const rejected: { memory: MemoryEntry; reason: string }[] = [];

  for (const memory of memories) {
    const result = validateExtractedMemory(memory.content);
    if (result.pass) {
      passed.push(memory);
    } else {
      rejected.push({ memory, reason: result.reason || 'unknown' });
    }
  }

  return { passed, rejected };
}

/**
 * Reset quality pipeline state (for testing)
 */
export function resetQualityState(): void {
  // Currently no persistent state, but reserved for future use
}
