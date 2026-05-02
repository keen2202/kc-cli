import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  initConsolidationService,
  getConsolidationStats,
  canConsolidate,
} from '../../src/services/memoryConsolidation';

// Mock all dependencies
vi.mock('fs/promises', () => ({
  stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/memory/paths', () => ({
  getProjectMemoryPath: vi.fn(() => '/tmp/test-memory'),
  getConsolidateLockPath: vi.fn(() => '/tmp/test-memory/.consolidate.lock'),
  ensureMemoryDir: vi.fn(),
  validateMemoryPath: vi.fn(() => true),
}));

vi.mock('../../src/memory/frontmatter', () => ({
  parseFrontmatter: vi.fn(() => ({ header: {}, body: '' })),
  composeMemoryFile: vi.fn(() => ''),
  validateMemoryType: vi.fn(() => 'project'),
}));

vi.mock('../../src/memory/scanner', () => ({
  scanMemoryFiles: vi.fn().mockResolvedValue([]),
  updateMemoryEntrypoint: vi.fn(),
}));

vi.mock('../../src/memory/FileMemoryService', () => ({
  FileMemoryService: vi.fn().mockImplementation(() => ({
    listMemories: vi.fn().mockResolvedValue([]),
    addMemory: vi.fn(),
  })),
}));

describe('memoryConsolidation', () => {
  describe('initConsolidationService', () => {
    it('should initialize without error', () => {
      const mockService = { listMemories: vi.fn() } as any;
      expect(() => initConsolidationService(mockService)).not.toThrow();
    });
  });

  describe('getConsolidationStats', () => {
    it('should return initial stats', () => {
      const stats = getConsolidationStats();
      expect(stats).toHaveProperty('inProgress');
      expect(stats).toHaveProperty('lastCompletedAt');
      expect(stats).toHaveProperty('totalConsolidations');
      expect(stats).toHaveProperty('totalMemoriesProcessed');
      expect(typeof stats.inProgress).toBe('boolean');
      expect(typeof stats.lastCompletedAt).toBe('number');
    });
  });

  describe('canConsolidate', () => {
    it('should return true when enough time has passed', () => {
      // lastCompletedAt starts at 0, so many hours have passed
      expect(canConsolidate(24)).toBe(true);
    });

    it('should use default 24 hours', () => {
      expect(canConsolidate()).toBe(true);
    });
  });
});
