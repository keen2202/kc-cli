import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFile, mockStat } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  stat: mockStat,
}));

vi.mock('../../src/memory/scanner', () => ({
  scanMemoryFiles: vi.fn(),
  loadMemoryEntrypoint: vi.fn(),
  formatMemoryManifest: vi.fn(),
}));

vi.mock('../../src/memory/relevanceSearch', () => ({
  findRelevantMemories: vi.fn(),
  getMemoryFreshnessText: vi.fn(),
}));

import { buildMemoryPrompt } from '../../src/memory/promptBuilder';
import { scanMemoryFiles, loadMemoryEntrypoint } from '../../src/memory/scanner';
import { findRelevantMemories, getMemoryFreshnessText } from '../../src/memory/relevanceSearch';

const mockScanMemoryFiles = vi.mocked(scanMemoryFiles);
const mockLoadEntrypoint = vi.mocked(loadMemoryEntrypoint);
const mockFindRelevant = vi.mocked(findRelevantMemories);
const mockFreshnessText = vi.mocked(getMemoryFreshnessText);

describe('promptBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildMemoryPrompt', () => {
    it('should include only guidelines when no memories and no entrypoint', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([]);
      mockFindRelevant.mockReturnValue([]);

      const result = await buildMemoryPrompt('test-hash', 'test query');

      // Guidelines are always included, so result is never empty
      expect(result).toContain('Memory System');
      expect(result).toContain('memory_guidelines');
      // But no entrypoint or relevant memories sections
      expect(result).not.toContain('<memory_index>');
      expect(result).not.toContain('<relevant_memories>');
    });

    it('should include entrypoint section when MEMORY.md exists', async () => {
      mockLoadEntrypoint.mockResolvedValue('# Memory Index\n\nSome content.');
      mockScanMemoryFiles.mockResolvedValue([]);
      mockFindRelevant.mockReturnValue([]);

      const result = await buildMemoryPrompt('test-hash', 'test query');

      expect(result).toContain('Memory System');
      expect(result).toContain('<memory_index>');
      expect(result).toContain('Memory Index');
      expect(result).toContain('</memory_index>');
    });

    it('should include relevant memories section', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([
        { fileName: 'relevant.md', description: 'Test', type: 'user', mtime: Date.now() },
      ]);
      mockFindRelevant.mockReturnValue(['relevant.md']);
      mockFreshnessText.mockReturnValue(null);
      mockReadFile.mockResolvedValue(
        `---\nname: relevant\ndescription: Test\ntype: user\n---\nMemory content here`
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);

      const result = await buildMemoryPrompt('test-hash', 'test query');

      expect(result).toContain('<relevant_memories>');
      expect(result).toContain('Memory: relevant');
      expect(result).toContain('Memory content here');
    });

    it('should always include memory guidelines', async () => {
      mockLoadEntrypoint.mockResolvedValue('# Index');
      mockScanMemoryFiles.mockResolvedValue([]);
      mockFindRelevant.mockReturnValue([]);

      const result = await buildMemoryPrompt('test-hash', 'test query');

      expect(result).toContain('memory_guidelines');
      expect(result).toContain('Memory Types');
    });

    it('should include freshness warnings for stale memories', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([
        { fileName: 'stale.md', description: 'Old memory', type: 'project', mtime: 1000 },
      ]);
      mockFindRelevant.mockReturnValue(['stale.md']);
      mockFreshnessText.mockReturnValue('(Last updated: 30d ago. Verify against current state.)');
      mockReadFile.mockResolvedValue(
        `---\nname: stale\ndescription: Old memory\ntype: project\n---\nOld content`
      );
      mockStat.mockResolvedValue({ mtimeMs: 1000 } as any);

      const result = await buildMemoryPrompt('test-hash', 'query');

      expect(result).toContain('Last updated');
      expect(result).toContain('Verify against current state');
    });

    it('should skip unreadable memory files gracefully', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([
        { fileName: 'broken.md', description: 'Broken', type: 'user', mtime: Date.now() },
      ]);
      mockFindRelevant.mockReturnValue(['broken.md']);
      mockFreshnessText.mockReturnValue(null);
      mockReadFile.mockRejectedValue(new Error('Permission denied'));

      const result = await buildMemoryPrompt('test-hash', 'query');

      // Should not crash; guidelines are still included but relevant memory is skipped
      expect(result).toContain('memory_guidelines');
      expect(result).not.toContain('Memory: broken');
    });

    it('should pass recentTools through to findRelevantMemories', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([
        { fileName: 'tool.md', description: 'Tool memory', type: 'user', mtime: Date.now() },
      ]);
      mockFindRelevant.mockReturnValue([]);

      await buildMemoryPrompt('test-hash', 'query', ['git', 'docker']);

      expect(mockFindRelevant).toHaveBeenCalledWith(
        'query',
        expect.any(Array),
        ['git', 'docker'],
        expect.any(Number)
      );
    });

    it('should respect maxRelevant parameter', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([
        { fileName: 'mem.md', description: 'Memory', type: 'user', mtime: Date.now() },
      ]);
      mockFindRelevant.mockReturnValue([]);

      await buildMemoryPrompt('test-hash', 'query', undefined, 3);

      expect(mockFindRelevant).toHaveBeenCalledWith(
        'query',
        expect.any(Array),
        undefined,
        3
      );
    });

    it('should use default maxRelevant of 5', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([
        { fileName: 'mem.md', description: 'Memory', type: 'user', mtime: Date.now() },
      ]);
      mockFindRelevant.mockReturnValue([]);

      await buildMemoryPrompt('test-hash', 'query');

      expect(mockFindRelevant).toHaveBeenCalledWith(
        'query',
        expect.any(Array),
        undefined,
        5
      );
    });

    it('should parse type and name from frontmatter when loading relevant memories', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([
        { fileName: 'typed.md', description: 'Typed', type: 'feedback', mtime: Date.now() },
      ]);
      mockFindRelevant.mockReturnValue(['typed.md']);
      mockFreshnessText.mockReturnValue(null);
      mockReadFile.mockResolvedValue(
        `---\nname: my_memory\ndescription: My Description\ntype: feedback\n---\nBody content`
      );
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);

      const result = await buildMemoryPrompt('test-hash', 'query');

      expect(result).toContain('Memory: my_memory');
      expect(result).toContain('Type: feedback');
      expect(result).toContain('Body content');
    });

    it('should handle memory file without frontmatter match', async () => {
      mockLoadEntrypoint.mockResolvedValue(null);
      mockScanMemoryFiles.mockResolvedValue([
        { fileName: 'nofm.md', description: 'No frontmatter', type: 'user', mtime: Date.now() },
      ]);
      mockFindRelevant.mockReturnValue(['nofm.md']);
      mockFreshnessText.mockReturnValue(null);
      mockReadFile.mockResolvedValue('Just plain text, no frontmatter');
      mockStat.mockResolvedValue({ mtimeMs: Date.now() } as any);

      const result = await buildMemoryPrompt('test-hash', 'query');

      // Memory without frontmatter should be skipped
      expect(result).not.toContain('Memory: nofm');
      // Guidelines are still present
      expect(result).toContain('memory_guidelines');
    });

    it('should truncate large entrypoint content', async () => {
      const hugeContent = 'Line\n'.repeat(300);
      mockLoadEntrypoint.mockResolvedValue(hugeContent);
      mockScanMemoryFiles.mockResolvedValue([]);
      mockFindRelevant.mockReturnValue([]);

      const result = await buildMemoryPrompt('test-hash', 'query');

      expect(result).toContain('<memory_index>');
      const indexContent = result.match(/<memory_index>([\s\S]*?)<\/memory_index>/)?.[1] || '';
      const lineCount = indexContent.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(202);
    });
  });
});
