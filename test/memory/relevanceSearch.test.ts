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

describe('relevanceSearch', () => {
  beforeEach(() => {
    resetRelevanceState();
  });

  describe('findRelevantMemories', () => {
    it('should return empty array for empty memories', () => {
      const result = findRelevantMemories('test query', []);
      expect(result).toEqual([]);
    });

    it('should return relevant memories sorted by score', () => {
      const memories = [
        makeManifest({ fileName: 'low.md', description: 'something unrelated' }),
        makeManifest({ fileName: 'high.md', description: 'TypeScript coding style guide for user' }),
        makeManifest({ fileName: 'mid.md', description: 'TypeScript related content' }),
      ];

      const result = findRelevantMemories('TypeScript coding', memories, undefined, 3);

      expect(result.length).toBe(3);
      expect(result[0]).toBe('high.md');
    });

    it('should respect limit parameter', () => {
      const memories = [
        makeManifest({ fileName: 'a.md', description: 'alpha' }),
        makeManifest({ fileName: 'b.md', description: 'beta' }),
        makeManifest({ fileName: 'c.md', description: 'gamma' }),
      ];

      const result = findRelevantMemories('test', memories, undefined, 2);
      expect(result.length).toBe(2);
    });

    it('should use default limit of 5', () => {
      const memories = Array.from({ length: 10 }, (_, i) =>
        makeManifest({ fileName: `file${i}.md`, description: `memory ${i}` })
      );

      const result = findRelevantMemories('memory', memories);
      expect(result.length).toBe(5);
    });

    it('should track loaded memories in feedback map', () => {
      const memories = [
        makeManifest({ fileName: 'tracked.md', description: 'test' }),
      ];

      findRelevantMemories('test', memories);

      const stats = getFeedbackStats('tracked.md');
      expect(stats).not.toBeNull();
      expect(stats!.loaded).toBe(1);
    });

    it('should return fewer results if fewer memories exist than limit', () => {
      const memories = [
        makeManifest({ fileName: 'only.md', description: 'test' }),
      ];

      const result = findRelevantMemories('test', memories, undefined, 10);
      expect(result.length).toBe(1);
    });
  });

  describe('calculateRelevanceScore', () => {
    it('should score exact description match highly', () => {
      const memory = makeManifest({
        description: 'TypeScript best practices for large projects',
        fileName: 'file.md',
      });

      const score = calculateRelevanceScore('TypeScript best practices', memory);

      expect(score).toBeGreaterThanOrEqual(50);
    });

    it('should give word-level matches in description', () => {
      const memory = makeManifest({
        description: 'advanced configuration management techniques',
        fileName: 'file.md',
      });

      const score = calculateRelevanceScore('configuration management', memory);

      expect(score).toBeGreaterThanOrEqual(20);
    });

    it('should score file name matches', () => {
      const memory = makeManifest({
        description: 'something generic',
        fileName: 'typescript-config.md',
      });

      const score = calculateRelevanceScore('typescript config', memory);

      // Should get 15 per word match in filename
      expect(score).toBeGreaterThanOrEqual(15);
    });

    it('should boost user type for preference queries', () => {
      const userMemory = makeManifest({ type: 'user', description: 'test memory', fileName: 'f.md' });
      const projectMemory = makeManifest({ type: 'project', description: 'test memory', fileName: 'g.md' });

      invalidateScoreCache();
      const userScore = calculateRelevanceScore('user preferences', userMemory);
      invalidateScoreCache();
      const projectScore = calculateRelevanceScore('user preferences', projectMemory);

      expect(userScore).toBeGreaterThan(projectScore);
    });

    it('should boost feedback type for lesson queries', () => {
      const feedbackMemory = makeManifest({ type: 'feedback', description: 'test', fileName: 'f.md' });
      const userMemory = makeManifest({ type: 'user', description: 'test', fileName: 'u.md' });

      invalidateScoreCache();
      const feedbackScore = calculateRelevanceScore('lesson learned', feedbackMemory);
      invalidateScoreCache();
      const userScore = calculateRelevanceScore('lesson learned', userMemory);

      expect(feedbackScore).toBeGreaterThan(userScore);
    });

    it('should boost project type for project/decision queries', () => {
      const projectMemory = makeManifest({ type: 'project', description: 'test', fileName: 'p.md' });
      const refMemory = makeManifest({ type: 'reference', description: 'test', fileName: 'r.md' });

      invalidateScoreCache();
      const projectScore = calculateRelevanceScore('project decision', projectMemory);
      invalidateScoreCache();
      const refScore = calculateRelevanceScore('project decision', refMemory);

      expect(projectScore).toBeGreaterThan(refScore);
    });

    it('should boost reference type for link/doc queries', () => {
      const refMemory = makeManifest({ type: 'reference', description: 'test', fileName: 'r.md' });
      const userMemory = makeManifest({ type: 'user', description: 'test', fileName: 'u.md' });

      invalidateScoreCache();
      const refScore = calculateRelevanceScore('reference doc link', refMemory);
      invalidateScoreCache();
      const userScore = calculateRelevanceScore('reference doc link', userMemory);

      expect(refScore).toBeGreaterThan(userScore);
    });

    it('should give recency boost for recent memories', () => {
      const recentMemory = makeManifest({
        mtime: Date.now(),
        description: 'test content',
        fileName: 'recent.md',
      });
      const oldMemory = makeManifest({
        mtime: Date.now() - 60 * 24 * 60 * 60 * 1000, // 60 days old
        description: 'test content',
        fileName: 'old.md',
      });

      invalidateScoreCache();
      const recentScore = calculateRelevanceScore('content', recentMemory);
      invalidateScoreCache();
      const oldScore = calculateRelevanceScore('content', oldMemory);

      expect(recentScore).toBeGreaterThanOrEqual(oldScore);
    });

    it('should give highest recency boost for today memories', () => {
      const today = makeManifest({ mtime: Date.now(), description: 'test', fileName: 't.md' });
      const weekOld = makeManifest({
        mtime: Date.now() - 3 * 24 * 60 * 60 * 1000,
        description: 'test',
        fileName: 'w.md',
      });

      invalidateScoreCache();
      const todayScore = calculateRelevanceScore('test', today);
      invalidateScoreCache();
      const weekScore = calculateRelevanceScore('test', weekOld);

      expect(todayScore).toBeGreaterThanOrEqual(weekScore);
    });

    it('should use recent tools for boosting', () => {
      const memory = makeManifest({
        description: 'Using git rebase for clean history',
        fileName: 'git.md',
      });

      invalidateScoreCache();
      const withTool = calculateRelevanceScore('rebase', memory, ['git']);
      invalidateScoreCache();
      const withoutTool = calculateRelevanceScore('rebase', memory);

      expect(withTool).toBeGreaterThanOrEqual(withoutTool);
    });

    it('should return 0 for completely irrelevant queries', () => {
      const memory = makeManifest({
        description: 'completely unrelated content about cooking',
        fileName: 'cooking.md',
        mtime: Date.now() - 365 * 24 * 60 * 60 * 1000, // Very old
      });

      invalidateScoreCache();
      const score = calculateRelevanceScore('quantum physics', memory);

      // Might have feedback multiplier but base score should be 0
      // With no feedback, multiplier is 1.0, so score = 0
      expect(score).toBe(0);
    });

    it('should ignore short query words (2 chars or less)', () => {
      const memory = makeManifest({
        description: 'is a test of the system',
        fileName: 'test.md',
      });

      // "is" and "a" should be ignored
      const score = calculateRelevanceScore('is a test', memory);

      // Only "test" should match (3+ chars)
      expect(score).toBeGreaterThanOrEqual(10);
    });

    it('should handle empty query', () => {
      const memory = makeManifest({
        description: 'some description',
        fileName: 'file.md',
      });

      invalidateScoreCache();
      const score = calculateRelevanceScore('', memory);

      // No word matches possible with empty query
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('feedback tracking and scoring', () => {
    it('should boost frequently referenced memories', () => {
      const memory = makeManifest({
        fileName: 'frequent.md',
        description: 'TypeScript coding style guide',
      });

      // Simulate high reference rate
      for (let i = 0; i < 10; i++) {
        findRelevantMemories('TypeScript', [memory]);
        if (i < 8) {
          markMemoriesReferenced(['frequent.md']);
        }
      }

      invalidateScoreCache();
      const score = calculateRelevanceScore('TypeScript', memory);

      const baseMemory = makeManifest({
        fileName: 'neutral.md',
        description: 'TypeScript coding style guide',
      });
      const baseScore = calculateRelevanceScore('TypeScript', baseMemory);

      expect(score).toBeGreaterThan(baseScore);
    });

    it('should penalize rarely referenced memories loaded many times', () => {
      const memory = makeManifest({
        fileName: 'ignored.md',
        description: 'TypeScript configuration tips',
      });

      for (let i = 0; i < 5; i++) {
        findRelevantMemories('TypeScript', [memory]);
      }

      invalidateScoreCache();
      const score = calculateRelevanceScore('TypeScript', memory);

      const neutralMemory = makeManifest({
        fileName: 'neutral.md',
        description: 'TypeScript configuration tips',
      });
      const neutralScore = calculateRelevanceScore('TypeScript', neutralMemory);

      expect(score).toBeLessThan(neutralScore);
    });

    it('should be neutral for moderate reference rates', () => {
      const memory = makeManifest({
        fileName: 'moderate.md',
        description: 'TypeScript debugging techniques',
      });

      for (let i = 0; i < 4; i++) {
        findRelevantMemories('TypeScript', [memory]);
        if (i < 2) {
          markMemoriesReferenced(['moderate.md']);
        }
      }

      invalidateScoreCache();
      const score = calculateRelevanceScore('TypeScript', memory);

      const neutralMemory = makeManifest({
        fileName: 'neutral.md',
        description: 'TypeScript debugging techniques',
      });
      const neutralScore = calculateRelevanceScore('TypeScript', neutralMemory);

      expect(Math.abs(score - neutralScore)).toBeLessThan(1);
    });

    it('should track referenced memories', () => {
      markMemoriesReferenced(['mem1.md', 'mem2.md']);

      const stats1 = getFeedbackStats('mem1.md');
      const stats2 = getFeedbackStats('mem2.md');

      expect(stats1).not.toBeNull();
      expect(stats1!.referenced).toBe(1);
      expect(stats2).not.toBeNull();
      expect(stats2!.referenced).toBe(1);
    });

    it('should accumulate loaded and referenced counts', () => {
      const memories = [makeManifest({ fileName: 'accum.md', description: 'test' })];

      findRelevantMemories('test', memories);
      findRelevantMemories('test', memories);
      markMemoriesReferenced(['accum.md']);

      const stats = getFeedbackStats('accum.md');
      expect(stats!.loaded).toBe(2);
      expect(stats!.referenced).toBe(1);
    });

    it('should return null for unknown feedback stats', () => {
      const stats = getFeedbackStats('unknown_file.md');
      expect(stats).toBeNull();
    });
  });

  describe('stale threshold', () => {
    it('should use default 30-day stale threshold', () => {
      expect(getStaleThreshold()).toBe(30);
    });

    it('should warn for memories older than threshold', () => {
      const now = Date.now();
      const fortyFiveDaysAgo = now - 45 * 24 * 60 * 60 * 1000;

      const text = getMemoryFreshnessText(fortyFiveDaysAgo);
      expect(text).not.toBeNull();
      expect(text).toContain('Verify against current state');
    });

    it('should not warn for fresh memories', () => {
      const now = Date.now();
      const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

      const text = getMemoryFreshnessText(twoDaysAgo);
      expect(text).toBeNull();
    });

    it('should respect custom stale threshold', () => {
      setStaleThreshold(7);

      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;

      const text = getMemoryFreshnessText(tenDaysAgo);
      expect(text).not.toBeNull();
    });

    it('should allow updating stale threshold', () => {
      setStaleThreshold(14);
      expect(getStaleThreshold()).toBe(14);
    });
  });

  describe('score caching', () => {
    it('should cache scores', () => {
      const memory = makeManifest({ fileName: 'cached.md', description: 'TypeScript best practices' });

      const score1 = calculateRelevanceScore('TypeScript', memory);
      const score2 = calculateRelevanceScore('TypeScript', memory);

      expect(score1).toBe(score2);
    });

    it('should invalidate cache', () => {
      const memory = makeManifest({ fileName: 'test.md', description: 'TypeScript tips' });

      calculateRelevanceScore('TypeScript', memory);
      invalidateScoreCache();
      // After invalidation, re-computing should still give same result
      const score = calculateRelevanceScore('TypeScript', memory);
      expect(score).toBeGreaterThan(0);
    });

    it('should produce different scores for different queries', () => {
      const memory = makeManifest({
        fileName: 'multi.md',
        description: 'TypeScript configuration guide',
      });

      const score1 = calculateRelevanceScore('TypeScript', memory);
      const score2 = calculateRelevanceScore('Python', memory);

      expect(score1).not.toBe(score2);
    });
  });

  describe('resetRelevanceState', () => {
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
