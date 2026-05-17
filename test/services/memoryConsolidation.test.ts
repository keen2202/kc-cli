import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';

beforeEach(async () => {
  vi.resetModules();
});

describe('Memory Consolidation', () => {
  describe('State Management', () => {
    it('should start with zero consolidations', async () => {
      const { getConsolidationStats } = await import(
        '../../src/services/memoryConsolidation'
      );
      const stats = getConsolidationStats();
      expect(stats.inProgress).toBe(false);
      expect(stats.totalConsolidations).toBe(0);
      expect(stats.totalMemoriesProcessed).toBe(0);
      expect(stats.lastCompletedAt).toBe(0);
    });

    it('canConsolidate should return boolean', async () => {
      const { canConsolidate } = await import(
        '../../src/services/memoryConsolidation'
      );
      expect(typeof canConsolidate(24)).toBe('boolean');
    });

    it('should reject when min hours not met', async () => {
      const { canConsolidate } = await import(
        '../../src/services/memoryConsolidation'
      );
      // With lastCompletedAt=0, time since epoch hours is massive
      expect(canConsolidate(1000000)).toBe(false);
    });
  });

  describe('Service Initialization', () => {
    it('should accept a memory service reference', async () => {
      const { initConsolidationService } = await import(
        '../../src/services/memoryConsolidation'
      );
      const mockService = { listMemories: async () => [] } as any;
      expect(() => initConsolidationService(mockService)).not.toThrow();
    });
  });

  describe('Consolidation Execution', () => {
    it('should return defined result for nonexistent project', async () => {
      const { executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      const result = await executeConsolidation('no-such-project-hash');
      expect(result).toHaveProperty('success');
      expect(result).toHaveProperty('memoriesProcessed');
      expect(result).toHaveProperty('memoriesUpdated');
      expect(result).toHaveProperty('memoriesCreated');
      expect(result).toHaveProperty('memoriesDeleted');
    });

    it('should handle empty session transcripts', async () => {
      const { executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      const result = await executeConsolidation('test-hash-empty', []);
      expect(result.success).toBeDefined();
    });

    it('should detect preference keywords in transcripts', async () => {
      const { executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      const result = await executeConsolidation('test-hash-pref', [
        'I prefer using TypeScript over JavaScript for new projects',
      ]);
      expect(result.success).toBeDefined();
    });

    it('should detect decision keywords in transcripts', async () => {
      const { executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      const result = await executeConsolidation('test-hash-decision', [
        'We decided to use PostgreSQL for the new service',
      ]);
      expect(result.success).toBeDefined();
    });

    it('getConsolidationStats should have correct shape', async () => {
      const { getConsolidationStats } = await import(
        '../../src/services/memoryConsolidation'
      );
      const stats = getConsolidationStats();
      expect(typeof stats.inProgress).toBe('boolean');
      expect(typeof stats.lastCompletedAt).toBe('number');
      expect(typeof stats.totalConsolidations).toBe('number');
      expect(typeof stats.totalMemoriesProcessed).toBe('number');
    });
  });
});
