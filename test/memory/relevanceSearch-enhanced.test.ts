import { describe, it, expect, beforeEach } from 'vitest';
import {
  findRelevantMemories,
  calculateRelevanceScore,
  markMemoriesReferenced,
  getMemoryFreshnessText,
  setStaleThreshold,
  getStaleThreshold,
  invalidateScoreCache,
  resetRelevanceState,
  getFeedbackStats,
} from '../../src/memory/relevanceSearch';
import type { MemoryManifestEntry } from '../../src/memory/types';

function makeManifest(overrides: Partial<MemoryManifestEntry> = {}): MemoryManifestEntry {
  return {
    fileName: 'test_memory.md',
    description: 'Test memory description',
    type: 'user',
    mtime: Date.now(),
    ...overrides,
  };
}

describe('Adaptive Relevance Scoring', () => {
  beforeEach(() => {
    resetRelevanceState();
  });

  describe('Feedback tracking', () => {
    it('should track loaded memories', () => {
      const memories = [
        makeManifest({ fileName: 'mem1.md', description: 'TypeScript preferences' }),
        makeManifest({ fileName: 'mem2.md', description: 'React patterns' }),
      ];

      findRelevantMemories('TypeScript', memories, undefined, 5);

      const stats1 = getFeedbackStats('mem1.md');
      const stats2 = getFeedbackStats('mem2.md');

      expect(stats1).not.toBeNull();
      expect(stats1!.loaded).toBe(1);
      expect(stats2).not.toBeNull();
      expect(stats2!.loaded).toBe(1);
    });

    it('should track referenced memories', () => {
      markMemoriesReferenced(['mem1.md', 'mem2.md']);

      const stats1 = getFeedbackStats('mem1.md');
      expect(stats1).not.toBeNull();
      expect(stats1!.referenced).toBe(1);
    });

    it('should accumulate loaded and referenced counts', () => {
      const memories = [makeManifest({ fileName: 'mem1.md', description: 'test' })];

      findRelevantMemories('test', memories);
      findRelevantMemories('test', memories);
      markMemoriesReferenced(['mem1.md']);

      const stats = getFeedbackStats('mem1.md');
      expect(stats!.loaded).toBe(2);
      expect(stats!.referenced).toBe(1);
    });
  });

  describe('Score adjustment based on feedback', () => {
    it('should boost frequently referenced memories', () => {
      const memory = makeManifest({ fileName: 'frequent.md', description: 'TypeScript coding style guide' });

      // Simulate high reference rate (7+ out of 10 loads)
      for (let i = 0; i < 10; i++) {
        findRelevantMemories('TypeScript', [memory]);
        if (i < 8) {
          markMemoriesReferenced(['frequent.md']);
        }
      }

      // Now score with fresh cache
      invalidateScoreCache();
      const score = calculateRelevanceScore('TypeScript', memory);

      // Score should be boosted (higher than base score * 1.0)
      const baseMemory = makeManifest({ fileName: 'neutral.md', description: 'TypeScript coding style guide' });
      const baseScore = calculateRelevanceScore('TypeScript', baseMemory);

      expect(score).toBeGreaterThan(baseScore);
    });

    it('should penalize rarely referenced memories loaded many times', () => {
      const memory = makeManifest({ fileName: 'ignored.md', description: 'TypeScript configuration tips' });

      // Simulate low reference rate (loaded 5 times, never referenced)
      for (let i = 0; i < 5; i++) {
        findRelevantMemories('TypeScript', [memory]);
        // Never mark as referenced
      }

      invalidateScoreCache();
      const score = calculateRelevanceScore('TypeScript', memory);

      const neutralMemory = makeManifest({ fileName: 'neutral.md', description: 'TypeScript configuration tips' });
      const neutralScore = calculateRelevanceScore('TypeScript', neutralMemory);

      expect(score).toBeLessThan(neutralScore);
    });

    it('should be neutral for memories with moderate reference rate', () => {
      const memory = makeManifest({ fileName: 'moderate.md', description: 'TypeScript debugging techniques' });

      // Moderate reference rate (loaded 4 times, referenced 2 times = 50%)
      for (let i = 0; i < 4; i++) {
        findRelevantMemories('TypeScript', [memory]);
        if (i < 2) {
          markMemoriesReferenced(['moderate.md']);
        }
      }

      invalidateScoreCache();
      const score = calculateRelevanceScore('TypeScript', memory);

      const neutralMemory = makeManifest({ fileName: 'neutral.md', description: 'TypeScript debugging techniques' });
      const neutralScore = calculateRelevanceScore('TypeScript', neutralMemory);

      // Should be approximately equal (within rounding)
      expect(Math.abs(score - neutralScore)).toBeLessThan(1);
    });
  });

  describe('Stale threshold', () => {
    it('should use configurable stale threshold (default 30 days)', () => {
      const now = Date.now();
      const fifteenDaysAgo = now - 15 * 24 * 60 * 60 * 1000;

      // 15-day-old memory should be fresh with 30-day threshold
      const text = getMemoryFreshnessText(fifteenDaysAgo);
      expect(text).toBeNull();
    });

    it('should warn when memory exceeds stale threshold', () => {
      const now = Date.now();
      const fortyFiveDaysAgo = now - 45 * 24 * 60 * 60 * 1000;

      // 45-day-old memory should be stale with 30-day threshold
      const text = getMemoryFreshnessText(fortyFiveDaysAgo);
      expect(text).not.toBeNull();
      expect(text).toContain('Verify against current state');
    });

    it('should respect custom stale threshold', () => {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

      // With 7-day threshold, 10-day-old memory should be stale
      setStaleThreshold(7);
      const text = getMemoryFreshnessText(tenDaysAgo);
      expect(text).not.toBeNull();
    });

    it('should return null for fresh memories within threshold', () => {
      const now = Date.now();
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

      setStaleThreshold(30);
      const text = getMemoryFreshnessText(twoDaysAgo);
      expect(text).toBeNull();
    });

    it('should allow getting current stale threshold', () => {
      setStaleThreshold(14);
      expect(getStaleThreshold()).toBe(14);
    });
  });

  describe('Score caching', () => {
    it('should cache scores within a session', () => {
      const memory = makeManifest({ fileName: 'cached.md', description: 'TypeScript best practices' });

      const score1 = calculateRelevanceScore('TypeScript', memory);
      const score2 = calculateRelevanceScore('TypeScript', memory);

      // Should return same cached value
      expect(score1).toBe(score2);
    });

    it('should invalidate cache when requested', () => {
      const memory = makeManifest({ fileName: 'test.md', description: 'TypeScript tips' });

      const score1 = calculateRelevanceScore('TypeScript', memory);
      invalidateScoreCache();
      const score2 = calculateRelevanceScore('TypeScript', memory);

      // Scores should be equal (same inputs) but cache was cleared
      expect(score1).toBe(score2);
    });

    it('should cache different scores for different queries', () => {
      const memory = makeManifest({ fileName: 'multi.md', description: 'TypeScript configuration guide' });

      const score1 = calculateRelevanceScore('TypeScript', memory);
      const score2 = calculateRelevanceScore('Python', memory);

      // Different queries should produce different scores
      expect(score1).not.toBe(score2);
    });
  });

  describe('Reset state', () => {
    it('should clear all feedback and cache data', () => {
      const memories = [makeManifest({ fileName: 'reset.md', description: 'test' })];

      findRelevantMemories('test', memories);
      markMemoriesReferenced(['reset.md']);

      resetRelevanceState();

      const stats = getFeedbackStats('reset.md');
      expect(stats).toBeNull();
    });

    it('should reset stale threshold to default', () => {
      setStaleThreshold(7);
      resetRelevanceState();
      expect(getStaleThreshold()).toBe(30);
    });
  });
});
