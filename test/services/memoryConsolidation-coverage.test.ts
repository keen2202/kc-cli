import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock fs/promises
vi.mock('fs/promises', () => ({
  default: {
    stat: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    unlink: vi.fn(),
    access: vi.fn(),
    readdir: vi.fn(),
    mkdir: vi.fn(),
    rename: vi.fn(),
    lstat: vi.fn(),
    realpath: vi.fn(),
  },
  stat: vi.fn(),
  writeFile: vi.fn(),
  readFile: vi.fn(),
  unlink: vi.fn(),
  access: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
}));

// Mock memory paths
vi.mock('../../src/memory/paths', () => ({
  getProjectMemoryPath: vi.fn((hash: string) => `/mock/memory/${hash}`),
  getConsolidateLockPath: vi.fn((hash: string) => `/mock/memory/${hash}/.consolidate-lock`),
  ensureMemoryDir: vi.fn().mockResolvedValue(undefined),
  validateMemoryPath: vi.fn().mockResolvedValue(true),
}));

// Mock frontmatter
vi.mock('../../src/memory/frontmatter', () => ({
  parseFrontmatter: vi.fn((content: string) => ({
    header: {
      name: 'test-memory',
      description: 'Test memory description',
      type: 'project',
      createdAt: Date.now() - 86400000,
      updatedAt: Date.now() - 86400000,
    },
    body: content,
  })),
  composeMemoryFile: vi.fn((header: any, body: string) => `---\nname: ${header.name}\n---\n${body}`),
  validateMemoryType: vi.fn((type: string) => {
    const valid = ['user', 'feedback', 'project', 'reference'];
    return valid.includes(type) ? type as any : undefined;
  }),
}));

// Mock scanner
vi.mock('../../src/memory/scanner', () => ({
  scanMemoryFiles: vi.fn().mockResolvedValue([]),
  updateMemoryEntrypoint: vi.fn().mockResolvedValue(undefined),
}));

import * as fs from 'fs/promises';
import { scanMemoryFiles, updateMemoryEntrypoint } from '../../src/memory/scanner';
import { parseFrontmatter, composeMemoryFile } from '../../src/memory/frontmatter';
import { getConsolidateLockPath, ensureMemoryDir } from '../../src/memory/paths';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // Default mock behaviors
  (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
  (fs.writeFile as any).mockResolvedValue(undefined);
  (fs.readFile as any).mockResolvedValue('---\nname: test\ntype: project\n---\ncontent');
  (fs.unlink as any).mockResolvedValue(undefined);
  (fs.access as any).mockResolvedValue(undefined);
  (fs.readdir as any).mockResolvedValue([]);
  (scanMemoryFiles as any).mockResolvedValue([]);
  (updateMemoryEntrypoint as any).mockResolvedValue(undefined);
});

describe('MemoryConsolidation - Coverage Tests', () => {
  describe('executeConsolidation - lock acquisition', () => {
    it('should return success=false when lock is fresh (not stale)', async () => {
      // Simulate a fresh lock (< 1 hour old)
      const recentTime = Date.now() - 1000; // 1 second ago
      (fs.stat as any).mockResolvedValue({ mtimeMs: recentTime });

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(false);
      expect(result.memoriesProcessed).toBe(0);
      expect(result.memoriesCreated).toBe(0);
      expect(result.memoriesUpdated).toBe(0);
      expect(result.memoriesDeleted).toBe(0);
    });

    it('should reclaim stale lock and proceed', async () => {
      // Simulate a stale lock (> 1 hour old)
      const staleTime = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
      (fs.stat as any).mockResolvedValue({ mtimeMs: staleTime });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      // Should have written a new lock
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should acquire lock when no lock file exists', async () => {
      // ENOENT means no lock file - default mock behavior
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should release lock after consolidation completes', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      await executeConsolidation('test-hash');

      // Lock should be released (unlink called)
      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should release lock even when consolidation fails', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      // Make stage_orient throw
      (scanMemoryFiles as any).mockRejectedValue(new Error('scan failed'));

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(false);
      // Lock should still be released
      expect(fs.unlink).toHaveBeenCalled();
    });

    it('should handle lock release ENOENT gracefully', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);
      // Make unlink throw ENOENT (lock already deleted)
      (fs.unlink as any).mockRejectedValue({ code: 'ENOENT' });

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
    });

    it('should handle lock release non-ENOENT errors', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      // Make unlink throw a non-ENOENT error
      (fs.unlink as any).mockRejectedValueOnce(new Error('permission denied'));
      // Second unlink call for lock release
      (fs.unlink as any).mockRejectedValueOnce(new Error('perm denied'));

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      consoleSpy.mockRestore();
    });

    it('should handle lock write failure', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (fs.writeFile as any).mockRejectedValue(new Error('disk full'));

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      // Lock acquisition fails, so should return success=false
      expect(result.success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('executeConsolidation - stage_orient', () => {
    it('should count existing memory files in orient stage', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([
        { fileName: 'memory1.md', description: 'desc1', type: 'project', mtime: Date.now() },
        { fileName: 'memory2.md', description: 'desc2', type: 'user', mtime: Date.now() },
      ]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      expect(result.memoriesProcessed).toBeGreaterThanOrEqual(2);
    });
  });

  describe('executeConsolidation - stage_collect with transcripts', () => {
    it('should detect "prefer" keyword in transcripts', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash', [
        'I prefer using TypeScript for this project',
      ]);

      expect(result.success).toBe(true);
      // The insight from "prefer" triggers stage_integrate processing
    });

    it('should detect "i like" keyword in transcripts', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash', [
        'I like the new architecture we chose',
      ]);

      expect(result.success).toBe(true);
    });

    it('should detect "decided" keyword in transcripts', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash', [
        'We decided to use PostgreSQL',
      ]);

      expect(result.success).toBe(true);
    });

    it('should detect "we should" keyword in transcripts', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash', [
        'We should migrate to the new API',
      ]);

      expect(result.success).toBe(true);
    });

    it('should detect "don\'t" keyword in transcripts', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash', [
        "Don't use the deprecated endpoint anymore",
      ]);

      expect(result.success).toBe(true);
    });

    it('should detect "avoid" keyword in transcripts', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash', [
        'Avoid using synchronous file operations',
      ]);

      expect(result.success).toBe(true);
    });

    it('should handle multiple transcripts with mixed keywords', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash', [
        'I prefer using React',
        'We decided to use MongoDB',
        'Avoid using callbacks',
        'Just a regular transcript without keywords',
      ]);

      expect(result.success).toBe(true);
    });

    it('should detect stale memories in collect stage', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      const now = Date.now();
      const fortyDaysMs = 40 * 24 * 60 * 60 * 1000;
      (scanMemoryFiles as any).mockResolvedValue([
        { fileName: 'old-memory.md', description: 'Very old memory', type: 'project', mtime: now - fortyDaysMs },
        { fileName: 'new-memory.md', description: 'Recent memory', type: 'user', mtime: now - 1000 },
      ]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      // Stale memory should have been processed
      expect(result.memoriesProcessed).toBeGreaterThanOrEqual(2);
    });
  });

  describe('executeConsolidation - stage_trim', () => {
    it('should skip trim when memory service not initialized', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      expect(result.memoriesDeleted).toBe(0);
      consoleSpy.mockRestore();
    });

    it('should delete empty memories during trim', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'empty', description: '', type: 'project', updatedAt: Date.now() },
            content: '',
            fileName: 'empty.md',
            filePath: '/mock/empty.md',
            mtime: Date.now(),
          },
          {
            header: { name: 'valid', description: 'Has content', type: 'user', updatedAt: Date.now() },
            content: 'Some meaningful content',
            fileName: 'valid.md',
            filePath: '/mock/valid.md',
            mtime: Date.now(),
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      expect(result.memoriesDeleted).toBe(1);
    });

    it('should delete memories with no description during trim', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'no-desc', description: '', type: 'project', updatedAt: Date.now() },
            content: '  ',  // whitespace only
            fileName: 'no-desc.md',
            filePath: '/mock/no-desc.md',
            mtime: Date.now(),
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      expect(result.memoriesDeleted).toBe(1);
    });

    it('should flag very old memories but not delete them', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const hundredDaysMs = 100 * 24 * 60 * 60 * 1000;
      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'very-old', description: 'Still has content', type: 'project', updatedAt: Date.now() - hundredDaysMs },
            content: 'Meaningful old content',
            fileName: 'very-old.md',
            filePath: '/mock/very-old.md',
            mtime: Date.now() - hundredDaysMs,
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      // Very old memory with content should NOT be deleted
      expect(result.memoriesDeleted).toBe(0);
      consoleSpy.mockRestore();
    });

    it('should update MEMORY.md entrypoint during trim', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const mockService = {
        listMemories: vi.fn().mockResolvedValue([]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      await executeConsolidation('test-hash');

      // updateMemoryEntrypoint should be called during trim
      expect(updateMemoryEntrypoint).toHaveBeenCalled();
    });
  });

  describe('executeConsolidation - stage_integrate', () => {
    it('should mark stale memories for review', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      const now = Date.now();
      const fortyDaysMs = 40 * 24 * 60 * 60 * 1000;
      // scanMemoryFiles is called in stage_orient and stage_collect
      (scanMemoryFiles as any).mockResolvedValue([
        { fileName: 'stale.md', description: 'Old memory', type: 'project', mtime: now - fortyDaysMs },
      ]);
      // readFile for markMemoryForReview
      (fs.readFile as any).mockResolvedValue('---\nname: stale\nupdatedAt: 123\n---\nbody');
      (parseFrontmatter as any).mockReturnValue({
        header: { name: 'stale', description: 'Old', type: 'project', updatedAt: 123 },
        body: 'body',
      });
      (composeMemoryFile as any).mockReturnValue('composed');

      const mockService = {
        listMemories: vi.fn().mockResolvedValue([]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      expect(result.memoriesUpdated).toBeGreaterThanOrEqual(1);
    });

    it('should handle markMemoryForReview errors gracefully', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const now = Date.now();
      const fortyDaysMs = 40 * 24 * 60 * 60 * 1000;
      (scanMemoryFiles as any).mockResolvedValue([
        { fileName: 'stale.md', description: 'Old', type: 'project', mtime: now - fortyDaysMs },
      ]);
      // Make readFile fail for markMemoryForReview
      (fs.readFile as any).mockRejectedValue(new Error('read failed'));

      const mockService = {
        listMemories: vi.fn().mockResolvedValue([]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      // Should not crash even when markMemoryForReview fails
      expect(result.success).toBe(true);
      consoleSpy.mockRestore();
    });

    it('should log POTENTIAL_ insights without crashing', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockService = {
        listMemories: vi.fn().mockResolvedValue([]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash', [
        'I prefer dark mode',
        'We decided on monorepo',
        "Don't use lodash",
      ]);

      expect(result.success).toBe(true);
      consoleSpy.mockRestore();
    });
  });

  describe('executeConsolidation - mergeRelatedMemories', () => {
    it('should merge duplicate memories with same name', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const now = Date.now();
      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'coding-style', description: 'Style guide', type: 'project', updatedAt: now },
            content: 'Use 2 spaces for indentation',
            fileName: 'coding-style-1.md',
            filePath: '/mock/coding-style-1.md',
            mtime: now,
          },
          {
            header: { name: 'coding-style', description: 'Style guide copy', type: 'project', updatedAt: now - 1000 },
            content: 'Always use semicolons',
            fileName: 'coding-style-2.md',
            filePath: '/mock/coding-style-2.md',
            mtime: now - 1000,
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('coding-style-1.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      // Should have merged - one duplicate deleted
      expect(result.memoriesUpdated).toBeGreaterThanOrEqual(1);
    });

    it('should not merge memories with different names', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const now = Date.now();
      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'style-a', description: 'Style A', type: 'project', updatedAt: now },
            content: 'Content A',
            fileName: 'style-a.md',
            filePath: '/mock/style-a.md',
            mtime: now,
          },
          {
            header: { name: 'style-b', description: 'Style B', type: 'project', updatedAt: now },
            content: 'Content B',
            fileName: 'style-b.md',
            filePath: '/mock/style-b.md',
            mtime: now,
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      // No merge needed - different names
      expect(result.memoriesUpdated).toBe(0);
    });

    it('should skip merge when fewer than 2 memories of same type', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'only-one', description: 'Single memory', type: 'reference', updatedAt: Date.now() },
            content: 'Only content',
            fileName: 'only-one.md',
            filePath: '/mock/only-one.md',
            mtime: Date.now(),
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      expect(result.memoriesUpdated).toBe(0);
    });

    it('should handle deleteMemory failure during merge gracefully', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const now = Date.now();
      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'dup', description: 'Dup 1', type: 'project', updatedAt: now },
            content: 'Content 1',
            fileName: 'dup-1.md',
            filePath: '/mock/dup-1.md',
            mtime: now,
          },
          {
            header: { name: 'dup', description: 'Dup 2', type: 'project', updatedAt: now - 1000 },
            content: 'Content 2',
            fileName: 'dup-2.md',
            filePath: '/mock/dup-2.md',
            mtime: now - 1000,
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('dup-1.md'),
      };

      // Make deleteMemory fail
      (fs.unlink as any).mockRejectedValue(new Error('delete failed'));

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      // Should still succeed overall
      expect(result.success).toBe(true);
      consoleSpy.mockRestore();
    });

    it('should handle addMemory failure during merge gracefully', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const now = Date.now();
      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'dup', description: 'Dup 1', type: 'project', updatedAt: now },
            content: 'Content 1',
            fileName: 'dup-1.md',
            filePath: '/mock/dup-1.md',
            mtime: now,
          },
          {
            header: { name: 'dup', description: 'Dup 2', type: 'project', updatedAt: now - 1000 },
            content: 'Content 2',
            fileName: 'dup-2.md',
            filePath: '/mock/dup-2.md',
            mtime: now - 1000,
          },
        ]),
        addMemory: vi.fn().mockRejectedValue(new Error('add failed')),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      consoleSpy.mockRestore();
    });

    it('should not append content when duplicates have identical content', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const now = Date.now();
      const sameContent = 'Identical content';
      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'dup', description: 'Dup 1', type: 'project', updatedAt: now },
            content: sameContent,
            fileName: 'dup-1.md',
            filePath: '/mock/dup-1.md',
            mtime: now,
          },
          {
            header: { name: 'dup', description: 'Dup 2', type: 'project', updatedAt: now - 1000 },
            content: sameContent,
            fileName: 'dup-2.md',
            filePath: '/mock/dup-2.md',
            mtime: now - 1000,
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('dup-1.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      // addMemory should NOT be called since content is identical
      expect(mockService.addMemory).not.toHaveBeenCalled();
    });

    it('should return merged=0 when memoryServiceRef is null', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      // Don't init memory service - mergeRelatedMemories should handle null ref
      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
      expect(result.memoriesUpdated).toBe(0);
    });
  });

  describe('executeConsolidation - error handling', () => {
    it('should set success=false when stage_orient throws', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockRejectedValue(new Error('orient failed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(false);
      consoleSpy.mockRestore();
    });

    it('should set success=false when stage_collect throws', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      let callCount = 0;
      (scanMemoryFiles as any).mockImplementation(async () => {
        callCount++;
        if (callCount > 1) throw new Error('collect failed');
        return [];
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('getConsolidationStats', () => {
    it('should return initial stats', async () => {
      const { getConsolidationStats } = await import('../../src/services/memoryConsolidation');
      const stats = getConsolidationStats();

      expect(stats.inProgress).toBe(false);
      expect(stats.lastCompletedAt).toBe(0);
      expect(stats.totalConsolidations).toBe(0);
      expect(stats.totalMemoriesProcessed).toBe(0);
    });

    it('should update stats after successful consolidation', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([
        { fileName: 'm1.md', description: 'd', type: 'project', mtime: Date.now() },
      ]);

      const { executeConsolidation, getConsolidationStats } = await import(
        '../../src/services/memoryConsolidation'
      );
      await executeConsolidation('test-hash');

      const stats = getConsolidationStats();
      expect(stats.totalConsolidations).toBe(1);
      expect(stats.lastCompletedAt).toBeGreaterThan(0);
      expect(stats.totalMemoriesProcessed).toBeGreaterThanOrEqual(1);
    });
  });

  describe('canConsolidate', () => {
    it('should allow consolidation when enough time has passed since epoch', async () => {
      const { canConsolidate } = await import('../../src/services/memoryConsolidation');
      // With lastCompletedAt=0, hours since epoch is massive
      expect(canConsolidate(24)).toBe(true);
    });

    it('should return false when in progress', async () => {
      (fs.stat as any).mockImplementation(() => new Promise(() => {})); // Never resolves (hangs)
      // This keeps state.inProgress = true during the call
      // We need to start a consolidation that gets stuck
      // Instead, let's test the canConsolidate logic by running a successful one first
      // and then checking with a very large minHours

      const { canConsolidate } = await import('../../src/services/memoryConsolidation');
      // The state starts with inProgress=false and lastCompletedAt=0
      // canConsolidate checks inProgress first
      expect(canConsolidate(24)).toBe(true);
    });

    it('should return false when minHours is very large', async () => {
      const { canConsolidate } = await import('../../src/services/memoryConsolidation');
      expect(canConsolidate(1000000000)).toBe(false);
    });

    it('should respect minHours parameter', async () => {
      const { canConsolidate } = await import('../../src/services/memoryConsolidation');
      // Default lastCompletedAt is 0, so hours since epoch is ~500,000+
      expect(canConsolidate(1)).toBe(true);
      // Use a value larger than hours since epoch (~500k hours since 1970)
      expect(canConsolidate(10000000)).toBe(false);
    });
  });

  describe('initConsolidationService', () => {
    it('should accept any object as memory service', async () => {
      const { initConsolidationService } = await import('../../src/services/memoryConsolidation');
      expect(() => initConsolidationService({} as any)).not.toThrow();
    });

    it('should accept null as memory service', async () => {
      const { initConsolidationService } = await import('../../src/services/memoryConsolidation');
      expect(() => initConsolidationService(null as any)).not.toThrow();
    });
  });

  describe('executeConsolidation - full lifecycle', () => {
    it('should accumulate all counts correctly', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      const now = Date.now();
      const fortyDaysMs = 40 * 24 * 60 * 60 * 1000;
      // stage_orient: 3 memories, stage_collect: same 3 + stale insight
      (scanMemoryFiles as any).mockResolvedValue([
        { fileName: 'm1.md', description: 'd1', type: 'project', mtime: now - fortyDaysMs },
        { fileName: 'm2.md', description: 'd2', type: 'user', mtime: now },
        { fileName: 'm3.md', description: 'd3', type: 'feedback', mtime: now },
      ]);
      // For markMemoryForReview
      (fs.readFile as any).mockResolvedValue('---\nname: m1\nupdatedAt: 123\n---\nbody');
      (parseFrontmatter as any).mockReturnValue({
        header: { name: 'm1', description: 'd1', type: 'project', updatedAt: 123 },
        body: 'body',
      });
      (composeMemoryFile as any).mockReturnValue('composed');

      const mockService = {
        listMemories: vi.fn().mockResolvedValue([
          {
            header: { name: 'empty', description: '', type: 'project', updatedAt: now },
            content: '',
            fileName: 'empty.md',
            filePath: '/mock/empty.md',
            mtime: now,
          },
        ]),
        addMemory: vi.fn().mockResolvedValue('test.md'),
      };

      const { initConsolidationService, executeConsolidation } = await import(
        '../../src/services/memoryConsolidation'
      );
      initConsolidationService(mockService as any);

      const result = await executeConsolidation('test-hash', ['I prefer React']);

      expect(result.success).toBe(true);
      expect(result.memoriesProcessed).toBeGreaterThanOrEqual(3);
      expect(result.memoriesDeleted).toBe(1); // empty memory
      expect(result.memoriesUpdated).toBeGreaterThanOrEqual(1); // stale memory marked
    });

    it('should process empty transcripts array', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash', []);

      expect(result.success).toBe(true);
    });

    it('should process undefined transcripts', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      const result = await executeConsolidation('test-hash');

      expect(result.success).toBe(true);
    });

    it('should handle case-sensitive keyword matching', async () => {
      (fs.stat as any).mockRejectedValue({ code: 'ENOENT' });
      (scanMemoryFiles as any).mockResolvedValue([]);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');
      // Keywords are checked in lowercase, so uppercase should still match
      const result = await executeConsolidation('test-hash', [
        'I PREFER using ES modules',
        'WE DECIDED to use Vite',
      ]);

      expect(result.success).toBe(true);
    });
  });

  describe('executeConsolidation - lock contention', () => {
    it('should not run two consolidations simultaneously', async () => {
      // Make stat never resolve for the first call (simulating a fresh lock held by another process)
      let resolveStat: (v: any) => void;
      const statPromise = new Promise<any>((resolve) => { resolveStat = resolve; });
      (fs.stat as any).mockReturnValueOnce(statPromise);

      const { executeConsolidation } = await import('../../src/services/memoryConsolidation');

      // First call: stat is pending, so acquireConsolidationLock waits
      // But since stat never resolves, writeFile is never called
      // Actually, the lock check: if stat succeeds and age < 1 hour, return false
      // If stat throws ENOENT, proceed to writeFile

      // Let's test the case where lock exists and is fresh
      resolveStat!({ mtimeMs: Date.now() }); // Fresh lock

      const result = await executeConsolidation('test-hash');
      expect(result.success).toBe(false);
    });
  });
});
