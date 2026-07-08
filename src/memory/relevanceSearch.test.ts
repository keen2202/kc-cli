// Tests for relevanceSearch feedbackMap bounds

import { describe, it, expect, beforeEach } from 'vitest';
import {
  findRelevantMemories,
  resetRelevanceState,
  getFeedbackStats,
  getFeedbackMapSize,
} from './relevanceSearch';
import type { MemoryManifestEntry } from './types';

describe('relevanceSearch feedbackMap bounds', () => {
  beforeEach(() => {
    resetRelevanceState();
  });

  it('should bound feedbackMap size after 10000 inserts (maxSize: 2000)', () => {
    // Create 10000 unique memories
    const memories: MemoryManifestEntry[] = [];
    for (let i = 0; i < 10000; i++) {
      memories.push({
        fileName: `memory-${i}.md`,
        description: `unique memory ${i} for testing`,
        type: 'reference',
        mtime: Date.now(),
        confidence: 'high',
      });
    }

    // Insert each memory into feedbackMap by calling findRelevantMemories
    // Each call processes a batch of 5, all returned in result (batch is the full list)
    for (let i = 0; i < 2000; i++) {
      const batch = memories.slice(i * 5, (i + 1) * 5);
      findRelevantMemories('test query', batch, [], 5);
    }

    // Verify the feedbackMap size is bounded by 2000
    const size = getFeedbackMapSize();
    expect(size).toBeLessThanOrEqual(2000);

    // Verify LRU eviction happened (earliest entries should be gone)
    expect(getFeedbackStats('memory-0.md')).toBeNull();

    // Verify recent entries still exist
    const lastEntry = getFeedbackStats('memory-9999.md');
    expect(lastEntry).not.toBeNull();
    expect(lastEntry!.loaded).toBe(1);
  });
});
