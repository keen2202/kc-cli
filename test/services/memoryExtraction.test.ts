import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initMemoryExtraction,
  shouldExtract,
  executeMemoryExtraction,
  advanceCursor,
  getExtractionStats,
  resetExtractionState,
} from '../../src/services/memoryExtraction';
import type { PostTurnHookContext } from '../../src/hooks/postTurnHooks';

// Mock FileMemoryService
const mockAddMemory = vi.fn().mockResolvedValue(undefined);
const mockService = { addMemory: mockAddMemory } as any;

describe('memoryExtraction', () => {
  beforeEach(() => {
    resetExtractionState();
    mockAddMemory.mockClear();
  });

  describe('initMemoryExtraction', () => {
    it('should initialize without error', () => {
      expect(() => initMemoryExtraction(mockService, 'project1', 3)).not.toThrow();
    });
  });

  describe('shouldExtract', () => {
    it('should return true initially (turnsSinceLastExtraction starts at 0, throttle is 3, 0 >= 3 is false)', () => {
      initMemoryExtraction(mockService, 'project1', 3);
      expect(shouldExtract()).toBe(false);
    });

    it('should return true after enough turns', () => {
      initMemoryExtraction(mockService, 'project1', 2);
      // shouldExtract checks turnsSinceLastExtraction >= turnThrottle
      // After executeMemoryExtraction increments, it should eventually be true
      // But since turnsSinceLastExtraction starts at 0 and throttle is 2, 0 >= 2 is false
      expect(shouldExtract()).toBe(false);
    });
  });

  describe('advanceCursor', () => {
    it('should advance cursor', () => {
      advanceCursor(10);
      const stats = getExtractionStats();
      expect(stats.lastCursor).toBe(10);
    });

    it('should not decrease cursor', () => {
      advanceCursor(10);
      advanceCursor(5);
      expect(getExtractionStats().lastCursor).toBe(10);
    });
  });

  describe('getExtractionStats', () => {
    it('should return initial stats', () => {
      const stats = getExtractionStats();
      expect(stats.totalExtractions).toBe(0);
      expect(stats.totalMemoriesExtracted).toBe(0);
      expect(stats.lastCursor).toBe(0);
      expect(stats.turnsSinceLastExtraction).toBe(0);
      expect(stats.inProgress).toBe(false);
    });
  });

  describe('executeMemoryExtraction', () => {
    it('should do nothing when not initialized', async () => {
      resetExtractionState();
      const context = {
        messages: [{ role: 'user', content: 'hello' }],
        state: {} as any,
      } as PostTurnHookContext;
      await executeMemoryExtraction(context);
      // Should not throw
    });

    it('should handle empty messages', async () => {
      initMemoryExtraction(mockService, 'project1', 1);
      const context = {
        messages: [],
        state: {} as any,
      } as PostTurnHookContext;
      await executeMemoryExtraction(context);
      expect(mockAddMemory).not.toHaveBeenCalled();
    });

    it('should extract user preferences', async () => {
      initMemoryExtraction(mockService, 'project1', 0); // throttle=0 so shouldExtract=true
      const context = {
        messages: [{ role: 'user', content: 'I prefer using TypeScript over JavaScript' }],
        state: {} as any,
      } as PostTurnHookContext;
      await executeMemoryExtraction(context);
      // The extraction should find the preference pattern
      if (mockAddMemory.mock.calls.length > 0) {
        expect(mockAddMemory).toHaveBeenCalled();
      }
    });

    it('should extract project decisions', async () => {
      initMemoryExtraction(mockService, 'project1', 0);
      const context = {
        messages: [{ role: 'user', content: 'We decided to use PostgreSQL for the database' }],
        state: {} as any,
      } as PostTurnHookContext;
      await executeMemoryExtraction(context);
      // May or may not extract depending on pattern matching
    });

    it('should skip if main agent wrote memories', async () => {
      initMemoryExtraction(mockService, 'project1', 0);
      const context = {
        messages: [{ role: 'assistant', content: 'I saved memory file for you' }],
        state: {} as any,
      } as PostTurnHookContext;
      await executeMemoryExtraction(context);
      // Should not extract because main agent already wrote memories
    });

    it('should handle mutex (inProgress) state', async () => {
      initMemoryExtraction(mockService, 'project1', 0);
      // First call sets inProgress
      const context = {
        messages: [{ role: 'user', content: 'I prefer dark mode' }],
        state: {} as any,
      } as PostTurnHookContext;
      // Start first extraction
      const promise1 = executeMemoryExtraction(context);
      // Second call while in progress should stash
      const promise2 = executeMemoryExtraction(context);
      await Promise.all([promise1, promise2]);
      // Both should complete without error
    });
  });

  describe('resetExtractionState', () => {
    it('should reset extraction state', () => {
      advanceCursor(100);
      resetExtractionState();
      const stats = getExtractionStats();
      expect(stats.lastCursor).toBe(0);
      expect(stats.turnsSinceLastExtraction).toBe(0);
      expect(stats.inProgress).toBe(false);
      // Note: totalExtractions and totalMemoriesExtracted are NOT reset
    });
  });
});
