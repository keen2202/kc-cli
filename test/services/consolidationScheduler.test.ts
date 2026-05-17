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
  getSessionBasePath: vi.fn(() => '/tmp/test-sessions'),
}));

describe('consolidationScheduler', () => {
  beforeEach(() => {
    resetScheduler();
    vi.clearAllMocks();
  });

  describe('shouldConsolidate', () => {
    it('should return true when lock does not exist and enough sessions', async () => {
      // Lock file doesn't exist (time gate passes), session gate checks files
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) throw new Error('ENOENT');
        return { mtimeMs: Date.now() }; // Session files are recent
      });
      (fs.readdir as any).mockResolvedValue(['session1.json', 'session2.json', 'session3.json', 'session4.json', 'session5.json']);
      const result = await shouldConsolidate('project1', { minSessions: 5 });
      expect(result).toBe(true);
    });

    it('should return false when not enough sessions exist', async () => {
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) throw new Error('ENOENT');
        return { mtimeMs: Date.now() };
      });
      (fs.readdir as any).mockResolvedValue(['session1.json']); // Only 1 session, need 5
      const result = await shouldConsolidate('project1', { minSessions: 5 });
      expect(result).toBe(false);
    });

    it('should return false when lock is fresh', async () => {
      (fs.stat as any).mockResolvedValue({ mtimeMs: Date.now() - 1000 }); // 1 second ago
      (fs.readdir as any).mockResolvedValue([]);
      const result = await shouldConsolidate('project1', { minHours: 24 });
      expect(result).toBe(false);
    });

    it('should return true when lock is old enough and enough sessions', async () => {
      const now = Date.now();
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) return { mtimeMs: now - 25 * 3600000 }; // 25 hours ago
        return { mtimeMs: now }; // Session files are recent
      });
      (fs.readdir as any).mockResolvedValue(['s1.json', 's2.json', 's3.json', 's4.json', 's5.json']);
      const result = await shouldConsolidate('project1', { minHours: 24, minSessions: 5 });
      expect(result).toBe(true);
    });

    it('should only count sessions modified after last consolidation', async () => {
      const now = Date.now();
      const lockTime = now - 25 * 3600000; // 25 hours ago
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) return { mtimeMs: lockTime };
        // 3 old sessions (before lock), 3 new sessions (after lock)
        if (p.includes('old')) return { mtimeMs: lockTime - 3600000 };
        return { mtimeMs: lockTime + 3600000 };
      });
      (fs.readdir as any).mockResolvedValue(['old1.json', 'old2.json', 'old3.json', 'new1.json', 'new2.json', 'new3.json']);
      const result = await shouldConsolidate('project1', { minHours: 24, minSessions: 5 });
      expect(result).toBe(false); // Only 3 new sessions, need 5
    });

    it('should respect scan throttle', async () => {
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) throw new Error('ENOENT');
        return { mtimeMs: Date.now() };
      });
      (fs.readdir as any).mockResolvedValue(['s1.json', 's2.json', 's3.json', 's4.json', 's5.json']);
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
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) throw new Error('ENOENT');
        return { mtimeMs: Date.now() };
      });
      (fs.readdir as any).mockResolvedValue(['s1.json', 's2.json', 's3.json', 's4.json', 's5.json']);
      const result = await scheduleConsolidation('project1');
      expect(result).toBe(true);
    });

    it('should return false when gates not passed', async () => {
      (fs.stat as any).mockResolvedValue({ mtimeMs: Date.now() }); // Just consolidated
      (fs.readdir as any).mockResolvedValue([]);
      const result = await scheduleConsolidation('project1');
      expect(result).toBe(false);
    });
  });

  describe('cancelConsolidation', () => {
    it('should cancel a scheduled consolidation', async () => {
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) throw new Error('ENOENT');
        return { mtimeMs: Date.now() };
      });
      (fs.readdir as any).mockResolvedValue(['s1.json', 's2.json', 's3.json', 's4.json', 's5.json']);
      await scheduleConsolidation('project1');
      cancelConsolidation('project1');
      const status = getConsolidationStatus('project1');
      expect(status.scheduled).toBe(false);
    });
  });

  describe('markConsolidationComplete', () => {
    it('should mark consolidation as complete', async () => {
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) throw new Error('ENOENT');
        return { mtimeMs: Date.now() };
      });
      (fs.readdir as any).mockResolvedValue(['s1.json', 's2.json', 's3.json', 's4.json', 's5.json']);
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
      (fs.stat as any).mockImplementation(async (p: string) => {
        if (p.includes('.consolidate.lock')) throw new Error('ENOENT');
        return { mtimeMs: Date.now() };
      });
      (fs.readdir as any).mockResolvedValue(['s1.json', 's2.json', 's3.json', 's4.json', 's5.json']);
      await scheduleConsolidation('project1');
      resetScheduler();
      const status = getConsolidationStatus('project1');
      expect(status.scheduled).toBe(false);
      expect(status.lastScanAt).toBe(0);
    });
  });
});
