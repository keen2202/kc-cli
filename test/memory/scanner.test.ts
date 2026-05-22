import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockReadFile,
  mockWriteFile,
  mockReaddir,
  mockStat,
  mockMkdir,
  mockAccess,
  mockRename,
} = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockReaddir: vi.fn(),
  mockStat: vi.fn(),
  mockMkdir: vi.fn(),
  mockAccess: vi.fn(),
  mockRename: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  readdir: mockReaddir,
  stat: mockStat,
  mkdir: mockMkdir,
  access: mockAccess,
  rename: mockRename,
}));

import {
  scanMemoryFiles,
  formatMemoryManifest,
  loadMemoryEntrypoint,
  updateMemoryEntrypoint,
} from '../../src/memory/scanner';
import type { MemoryManifestEntry } from '../../src/memory/types';

function makeManifestEntry(overrides: Partial<MemoryManifestEntry> = {}): MemoryManifestEntry {
  return {
    fileName: 'test.md',
    description: 'A test memory',
    type: 'user',
    mtime: Date.now(),
    ...overrides,
  };
}

describe('scanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('scanMemoryFiles', () => {
    it('should return empty array when directory does not exist', async () => {
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      const result = await scanMemoryFiles('nonexistent-hash');
      expect(result).toEqual([]);
    });

    it('should scan and return memory files with valid frontmatter', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['memory1.md', 'memory2.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValueOnce(
        `---\nname: mem1\ndescription: First memory\ntype: user\n---\nContent 1`
      );
      mockReadFile.mockResolvedValueOnce(
        `---\nname: mem2\ndescription: Second memory\ntype: project\n---\nContent 2`
      );

      const result = await scanMemoryFiles('test-hash');

      expect(result.length).toBe(2);
      expect(result[0].fileName).toBeDefined();
      expect(result[0].description).toBeDefined();
      expect(result[0].type).toBeDefined();
      expect(result[0].mtime).toBeDefined();
    });

    it('should exclude MEMORY.md from results', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['MEMORY.md', 'valid.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(
        `---\nname: valid\ndescription: Valid memory\ntype: user\n---\nContent`
      );

      const result = await scanMemoryFiles('test-hash');

      expect(result.length).toBe(1);
      expect(result[0].fileName).toBe('valid.md');
    });

    it('should exclude hidden files', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['.hidden.md', 'visible.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(
        `---\nname: vis\ndescription: Visible\ntype: user\n---\nContent`
      );

      const result = await scanMemoryFiles('test-hash');
      expect(result.length).toBe(1);
      expect(result[0].fileName).toBe('visible.md');
    });

    it('should skip files with invalid frontmatter', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['invalid.md', 'valid.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValueOnce('No frontmatter at all');
      mockReadFile.mockResolvedValueOnce(
        `---\nname: valid\ndescription: Good\ntype: user\n---\nContent`
      );

      const result = await scanMemoryFiles('test-hash');
      expect(result.length).toBe(1);
      expect(result[0].fileName).toBe('valid.md');
    });

    it('should skip files with invalid memory type', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['bad_type.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(
        `---\nname: bad\ndescription: Bad type\ntype: invalid_type\n---\nContent`
      );

      const result = await scanMemoryFiles('test-hash');
      expect(result.length).toBe(0);
    });

    it('should sort by mtime descending (newest first)', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['old.md', 'new.md'] as any);

      const now = Date.now();
      mockStat.mockResolvedValueOnce({ mtimeMs: now - 100000 } as any);
      mockStat.mockResolvedValueOnce({ mtimeMs: now } as any);
      mockReadFile.mockResolvedValue(
        `---\nname: mem\ndescription: Memory\ntype: user\n---\nContent`
      );

      const result = await scanMemoryFiles('test-hash');
      expect(result.length).toBe(2);
      expect(result[0].mtime).toBeGreaterThanOrEqual(result[1].mtime);
    });

    it('should respect the limit parameter', async () => {
      mockAccess.mockResolvedValue(undefined);
      const files = Array.from({ length: 10 }, (_, i) => `file${i}.md`);
      mockReaddir.mockResolvedValue(files as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(
        `---\nname: mem\ndescription: Memory\ntype: user\n---\nContent`
      );

      const result = await scanMemoryFiles('test-hash', 3);
      expect(result.length).toBeLessThanOrEqual(3);
    });

    it('should handle read errors for individual files gracefully', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['bad.md', 'good.md'] as any);
      mockStat.mockRejectedValueOnce(new Error('Permission denied'));
      mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(
        `---\nname: good\ndescription: Good memory\ntype: user\n---\nContent`
      );

      const result = await scanMemoryFiles('test-hash');
      expect(result.length).toBe(1);
      expect(result[0].fileName).toBe('good.md');
    });

    it('should filter out non-.md files', async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReaddir.mockResolvedValue(['file.txt', 'file.json', 'valid.md'] as any);
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);
      mockReadFile.mockResolvedValue(
        `---\nname: valid\ndescription: Valid\ntype: user\n---\nContent`
      );

      const result = await scanMemoryFiles('test-hash');
      expect(result.length).toBe(1);
      expect(result[0].fileName).toBe('valid.md');
    });
  });

  describe('formatMemoryManifest', () => {
    it('should return "No existing memories found." for empty array', () => {
      const result = formatMemoryManifest([]);
      expect(result).toBe('No existing memories found.');
    });

    it('should format a single memory entry', () => {
      const entries = [makeManifestEntry({ fileName: 'test.md', description: 'Test desc', type: 'user' })];

      const result = formatMemoryManifest(entries);

      expect(result).toContain('Existing memories:');
      expect(result).toContain('[user] test.md');
      expect(result).toContain('Test desc');
    });

    it('should format multiple memory entries', () => {
      const entries = [
        makeManifestEntry({ fileName: 'a.md', description: 'First', type: 'user' }),
        makeManifestEntry({ fileName: 'b.md', description: 'Second', type: 'feedback' }),
        makeManifestEntry({ fileName: 'c.md', description: 'Third', type: 'project' }),
      ];

      const result = formatMemoryManifest(entries);

      expect(result).toContain('[user] a.md');
      expect(result).toContain('[feedback] b.md');
      expect(result).toContain('[project] c.md');
    });

    it('should include age text from mtime', () => {
      const now = Date.now();
      const entries = [makeManifestEntry({ mtime: now })];

      const result = formatMemoryManifest(entries);
      expect(result).toContain('just now');
    });
  });

  describe('loadMemoryEntrypoint', () => {
    it('should return content of MEMORY.md when it exists', async () => {
      const content = '# Memory Index\n\nSome content here.';
      mockReadFile.mockResolvedValue(content);

      const result = await loadMemoryEntrypoint('test-hash');
      expect(result).toBe(content);
    });

    it('should return null when MEMORY.md does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));

      const result = await loadMemoryEntrypoint('test-hash');
      expect(result).toBeNull();
    });

    it('should return null on any read error', async () => {
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      const result = await loadMemoryEntrypoint('test-hash');
      expect(result).toBeNull();
    });
  });

  describe('updateMemoryEntrypoint', () => {
    beforeEach(() => {
      mockMkdir.mockResolvedValue(undefined);
      mockWriteFile.mockResolvedValue(undefined);
      mockRename.mockResolvedValue(undefined);
    });

    it('should write MEMORY.md with grouped entries', async () => {
      const entries = [
        makeManifestEntry({ fileName: 'user1.md', description: 'User memory', type: 'user' }),
        makeManifestEntry({ fileName: 'proj1.md', description: 'Project memory', type: 'project' }),
      ];

      await updateMemoryEntrypoint('test-hash', entries);

      expect(mockMkdir).toHaveBeenCalled();
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockRename).toHaveBeenCalled();

      const writeCall = mockWriteFile.mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain('# Memory Index');
      expect(content).toContain('## User');
      expect(content).toContain('## Project');
      expect(content).toContain('user1.md');
      expect(content).toContain('proj1.md');
    });

    it('should handle empty entries array', async () => {
      await updateMemoryEntrypoint('test-hash', []);

      expect(mockWriteFile).toHaveBeenCalled();
      const writeCall = mockWriteFile.mock.calls[0];
      const content = writeCall[1] as string;
      expect(content).toContain('# Memory Index');
    });

    it('should use atomic write pattern (temp file + rename)', async () => {
      await updateMemoryEntrypoint('test-hash', []);

      const writePath = mockWriteFile.mock.calls[0][0] as string;
      const renameFrom = mockRename.mock.calls[0][0] as string;
      const renameTo = mockRename.mock.calls[0][1] as string;

      expect(writePath.endsWith('.tmp')).toBe(true);
      expect(renameFrom).toBe(writePath);
      expect(renameTo.endsWith('.tmp')).toBe(false);
    });

    it('should truncate long description lines', async () => {
      const longDesc = 'A'.repeat(200);
      const entries = [makeManifestEntry({ fileName: 'long.md', description: longDesc, type: 'user' })];

      await updateMemoryEntrypoint('test-hash', entries);

      const content = mockWriteFile.mock.calls[0][1] as string;
      expect(content).toContain('...');
    });

    it('should respect maxLines parameter', async () => {
      const entries = Array.from({ length: 50 }, (_, i) =>
        makeManifestEntry({ fileName: `file${i}.md`, description: `Memory ${i}`, type: 'user' })
      );

      await updateMemoryEntrypoint('test-hash', entries, 10);

      const content = mockWriteFile.mock.calls[0][1] as string;
      expect(content).toContain('truncated');
    });

    it('should group entries by type in correct order', async () => {
      const entries = [
        makeManifestEntry({ fileName: 'ref.md', description: 'Ref', type: 'reference' }),
        makeManifestEntry({ fileName: 'user.md', description: 'User', type: 'user' }),
        makeManifestEntry({ fileName: 'feedback.md', description: 'Feedback', type: 'feedback' }),
        makeManifestEntry({ fileName: 'proj.md', description: 'Proj', type: 'project' }),
      ];

      await updateMemoryEntrypoint('test-hash', entries);

      const content = mockWriteFile.mock.calls[0][1] as string;
      const userPos = content.indexOf('## User');
      const feedbackPos = content.indexOf('## Feedback');
      const projectPos = content.indexOf('## Project');
      const referencePos = content.indexOf('## Reference');

      expect(userPos).toBeLessThan(feedbackPos);
      expect(feedbackPos).toBeLessThan(projectPos);
      expect(projectPos).toBeLessThan(referencePos);
    });
  });
});
