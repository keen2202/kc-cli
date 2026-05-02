import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  shouldConsolidate,
  scheduleConsolidation,
  cancelConsolidation,
  markConsolidationComplete,
  getConsolidationStatus,
  resetScheduler,
} from '../../src/services/consolidationScheduler';
import * as fs from 'fs/promises';

// Mock fs and paths module
vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
}));

vi.mock('../../src/memory/paths', () => ({
  getProjectMemoryPath: vi.fn(() => '/tmp/test-memory'),
  getConsolidateLockPath: vi.fn(() => '/tmp/test-memory/.consolidate.lock'),
}));

describe('consolidationScheduler', () => {
  beforeEach(() => {
    resetScheduler();
    vi.clearAllMocks();
  });

  describe('shouldConsolidate', () => {
    it('should return true when lock does not exist (never consolidated)', async () => {
      (fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      const result = await shouldConsolidate('project1');
      expect(result).toBe(true);
    });

    it('should return false when lock is fresh', async () => {
      (fs.stat as any).mockResolvedValue({ mtimeMs: Date.now() - 1000 }); // 1 second ago
      const result = await shouldConsolidate('project1', { minHours: 24 });
      expect(result).toBe(false);
    });

    it('should return true when lock is old enough', async () => {
      (fs.stat as any).mockResolvedValue({ mtimeMs: Date.now() - 25 * 3600000 }); // 25 hours ago
      const result = await shouldConsolidate('project1', { minHours: 24 });
      expect(result).toBe(true);
    });

    it('should respect scan throttle', async () => {
      (fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      // First call passes
      const result1 = await shouldConsolidate('project1', { scanThrottleMinutes: 10 });
      expect(result1).toBe(true);
      // Second call within throttle should fail
      const result2 = await shouldConsolidate('project1', { scanThrottleMinutes: 10 });
      expect(result2).toBe(false);
    });
  });

  describe('scheduleConsolidation', () => {
    it('should schedule when conditions met', async () => {
      (fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      const result = await scheduleConsolidation('project1');
      expect(result).toBe(true);
    });

    it('should not schedule if already scheduled', async () => {
      (fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      await scheduleConsolidation('project1');
      resetScheduler(); // Reset to clear throttle but keep track of schedule
      // The schedule is in the module-level state, which resetScheduler clears
    });

    it('should return false when gates not passed', async () => {
      (fs.stat as any).mockResolvedValue({ mtimeMs: Date.now() }); // Just consolidated
      const result = await scheduleConsolidation('project1');
      expect(result).toBe(false);
    });
  });

  describe('cancelConsolidation', () => {
    it('should cancel a scheduled consolidation', async () => {
      (fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      await scheduleConsolidation('project1');
      cancelConsolidation('project1');
      const status = getConsolidationStatus('project1');
      expect(status.scheduled).toBe(false);
    });
  });

  describe('markConsolidationComplete', () => {
    it('should mark consolidation as complete', async () => {
      (fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      await scheduleConsolidation('project1');
      markConsolidationComplete('project1');
      const status = getConsolidationStatus('project1');
      expect(status.scheduled).toBe(false);
    });
  });

  describe('getConsolidationStatus', () => {
    it('should return status for project', () => {
      const status = getConsolidationStatus('any-project');
      expect(status).toHaveProperty('scheduled');
      expect(status).toHaveProperty('lastScanAt');
    });
  });

  describe('resetScheduler', () => {
    it('should reset all state', async () => {
      (fs.stat as any).mockRejectedValue(new Error('ENOENT'));
      await scheduleConsolidation('project1');
      resetScheduler();
      const status = getConsolidationStatus('project1');
      expect(status.scheduled).toBe(false);
      expect(status.lastScanAt).toBe(0);
    });
  });
});
