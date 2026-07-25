import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../../src/memory/relevanceSearch', () => ({
  findRelevantMemories: vi.fn(),
}));

vi.mock('../../src/services/memoryExtraction', () => ({
  extractMemoriesFromMessages: vi.fn(),
  extractMemoriesHybrid: vi.fn(),
}));

import {
  MemoryIntegration,
  createMemoryIntegration,
} from '../../src/memory/integration';
import { findRelevantMemories } from '../../src/memory/relevanceSearch';
import { extractMemoriesHybrid } from '../../src/services/memoryExtraction';
import type { MemoryManifestEntry, MemoryEntry, MemoryConfig } from '../../src/memory/types';
import type { ChatMessage } from '../../src/types/message';

const mockFindRelevant = vi.mocked(findRelevantMemories);
// Integration now calls the hybrid orchestrator; bind the mock to it.
const mockExtractMemories = vi.mocked(extractMemoriesHybrid);

function makeManifest(overrides: Partial<MemoryManifestEntry> = {}): MemoryManifestEntry {
  return {
    fileName: 'test.md',
    description: 'Test memory',
    type: 'user',
    mtime: Date.now(),
    ...overrides,
  };
}

function makeMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    header: {
      name: 'test_memory',
      description: 'A test memory',
      type: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    content: 'Test content',
    filePath: '/path/to/test.md',
    fileName: 'test.md',
    mtime: Date.now(),
    ...overrides,
  };
}

function makeChatMessage(role: string, content: string): ChatMessage {
  return {
    id: `msg-${Date.now()}`,
    role: role as any,
    content,
    timestamp: Date.now(),
  };
}

describe('MemoryIntegration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const integration = new MemoryIntegration({});
      expect(integration).toBeDefined();
      expect(integration.isEnabled()).toBe(true);
    });

    it('should merge custom config with defaults', () => {
      const integration = new MemoryIntegration({
        config: { enabled: false, autoExtract: false },
      });

      expect(integration.isEnabled()).toBe(false);
      const config = integration.getConfig();
      expect(config.autoExtract).toBe(false);
      // Other defaults should be preserved
      expect(config.autoConsolidate).toBe(true);
    });

    it('should use default project hash if not provided', () => {
      const integration = new MemoryIntegration({});
      const config = integration.getConfig();
      // Just verifying it doesn't throw
      expect(config).toBeDefined();
    });

    it('should accept custom project hash', () => {
      const integration = new MemoryIntegration({ projectHash: 'custom-hash' });
      expect(integration).toBeDefined();
    });
  });

  describe('loadRelevantMemories', () => {
    it('should return empty string when disabled', async () => {
      const integration = new MemoryIntegration({ config: { enabled: false } });

      const result = await integration.loadRelevantMemories('test query');
      expect(result).toBe('');
    });

    it('should return empty string when manifest is empty', async () => {
      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [],
      });

      const result = await integration.loadRelevantMemories('test query');
      expect(result).toBe('');
    });

    it('should return empty string when no relevant memories found', async () => {
      mockFindRelevant.mockReturnValue([]);

      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [makeManifest()],
      });

      const result = await integration.loadRelevantMemories('test query');
      expect(result).toBe('');
    });

    it('should return formatted memory content for relevant memories', async () => {
      mockFindRelevant.mockReturnValue(['relevant.md']);

      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [makeManifest()],
        getMemoryContent: async (fileName) => {
          if (fileName === 'relevant.md') return 'Relevant memory content';
          return null;
        },
      });

      const result = await integration.loadRelevantMemories('test query');

      expect(result).toContain('Relevant Memories');
      expect(result).toContain('Relevant memory content');
    });

    it('should join multiple memory contents with separator', async () => {
      mockFindRelevant.mockReturnValue(['mem1.md', 'mem2.md']);

      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [
          makeManifest({ fileName: 'mem1.md' }),
          makeManifest({ fileName: 'mem2.md' }),
        ],
        getMemoryContent: async (fileName) => {
          if (fileName === 'mem1.md') return 'Content 1';
          if (fileName === 'mem2.md') return 'Content 2';
          return null;
        },
      });

      const result = await integration.loadRelevantMemories('test query');

      expect(result).toContain('Content 1');
      expect(result).toContain('Content 2');
    });

    it('should skip memories with null content', async () => {
      mockFindRelevant.mockReturnValue(['exists.md', 'missing.md']);

      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [
          makeManifest({ fileName: 'exists.md' }),
          makeManifest({ fileName: 'missing.md' }),
        ],
        getMemoryContent: async (fileName) => {
          if (fileName === 'exists.md') return 'Found it';
          return null;
        },
      });

      const result = await integration.loadRelevantMemories('test query');

      expect(result).toContain('Found it');
    });

    it('should return empty string when all memory content is null', async () => {
      mockFindRelevant.mockReturnValue(['missing.md']);

      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [makeManifest()],
        getMemoryContent: async () => null,
      });

      const result = await integration.loadRelevantMemories('test query');
      expect(result).toBe('');
    });

    it('should handle errors gracefully and return empty string', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const integration = new MemoryIntegration({
        getMemoryManifest: async () => {
          throw new Error('Network error');
        },
      });

      const result = await integration.loadRelevantMemories('test query');
      expect(result).toBe('');
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should pass recentTools to findRelevantMemories', async () => {
      mockFindRelevant.mockReturnValue([]);

      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [makeManifest()],
      });

      await integration.loadRelevantMemories('query', ['git', 'npm']);

      expect(mockFindRelevant).toHaveBeenCalledWith(
        'query',
        expect.any(Array),
        ['git', 'npm'],
        expect.any(Number)
      );
    });

    it('should use relevanceSearchLimit from config', async () => {
      mockFindRelevant.mockReturnValue([]);

      const integration = new MemoryIntegration({
        config: { relevanceSearchLimit: 10 },
        getMemoryManifest: async () => [makeManifest()],
      });

      await integration.loadRelevantMemories('query');

      expect(mockFindRelevant).toHaveBeenCalledWith(
        'query',
        expect.any(Array),
        undefined,
        10
      );
    });
  });

  describe('extractMemoriesFromConversation', () => {
    it('should not extract when disabled', async () => {
      const saveMemory = vi.fn();
      const integration = new MemoryIntegration({
        config: { enabled: false },
        saveMemory,
      });

      await integration.extractMemoriesFromConversation([]);
      expect(mockExtractMemories).not.toHaveBeenCalled();
      expect(saveMemory).not.toHaveBeenCalled();
    });

    it('should not extract when autoExtract is false', async () => {
      const saveMemory = vi.fn();
      const integration = new MemoryIntegration({
        config: { autoExtract: false },
        saveMemory,
      });

      await integration.extractMemoriesFromConversation([]);
      expect(mockExtractMemories).not.toHaveBeenCalled();
    });

    it('should extract and save memories from conversation', async () => {
      const memory = makeMemoryEntry({ fileName: 'new_memory.md' });
      mockExtractMemories.mockResolvedValue([memory]);

      const saveMemory = vi.fn().mockResolvedValue(undefined);
      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [],
        saveMemory,
      });

      const messages = [makeChatMessage('user', 'I prefer TypeScript')];
      await integration.extractMemoriesFromConversation(messages);

      expect(mockExtractMemories).toHaveBeenCalledWith(messages, expect.anything());
      expect(saveMemory).toHaveBeenCalledWith(memory);
    });

    it('should deduplicate by skipping memories that already exist', async () => {
      const existing = makeMemoryEntry({ fileName: 'existing.md' });
      const newMem = makeMemoryEntry({ fileName: 'new.md' });

      mockExtractMemories.mockResolvedValue([existing, newMem]);

      const saveMemory = vi.fn().mockResolvedValue(undefined);
      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [
          makeManifest({ fileName: 'existing.md' }),
        ],
        saveMemory,
      });

      await integration.extractMemoriesFromConversation([
        makeChatMessage('user', 'test'),
      ]);

      // Only new.md should be saved, existing.md skipped
      expect(saveMemory).toHaveBeenCalledTimes(1);
      expect(saveMemory).toHaveBeenCalledWith(newMem);
    });

    it('should handle save errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const memory = makeMemoryEntry({ fileName: 'fail.md' });
      mockExtractMemories.mockResolvedValue([memory]);

      const saveMemory = vi.fn().mockRejectedValue(new Error('Disk full'));
      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [],
        saveMemory,
      });

      await integration.extractMemoriesFromConversation([
        makeChatMessage('user', 'test'),
      ]);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should not call saveMemory when no memories extracted', async () => {
      mockExtractMemories.mockResolvedValue([]);

      const saveMemory = vi.fn();
      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [],
        saveMemory,
      });

      await integration.extractMemoriesFromConversation([
        makeChatMessage('user', 'nothing interesting'),
      ]);

      expect(saveMemory).not.toHaveBeenCalled();
    });

    it('should handle extraction errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      mockExtractMemories.mockRejectedValue(new Error('Extraction failed'));

      const integration = new MemoryIntegration({
        getMemoryManifest: async () => [],
      });

      await integration.extractMemoriesFromConversation([
        makeChatMessage('user', 'test'),
      ]);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('shouldRunConsolidation', () => {
    it('should return false when disabled', () => {
      const integration = new MemoryIntegration({ config: { enabled: false } });
      expect(integration.shouldRunConsolidation(10, 48)).toBe(false);
    });

    it('should return false when autoConsolidate is false', () => {
      const integration = new MemoryIntegration({ config: { autoConsolidate: false } });
      expect(integration.shouldRunConsolidation(10, 48)).toBe(false);
    });

    it('should return true when both thresholds are met', () => {
      const integration = new MemoryIntegration({
        config: {
          consolidationMinSessions: 5,
          consolidationMinHours: 24,
        },
      });

      expect(integration.shouldRunConsolidation(5, 24)).toBe(true);
      expect(integration.shouldRunConsolidation(10, 48)).toBe(true);
    });

    it('should return false when sessions threshold is not met', () => {
      const integration = new MemoryIntegration({
        config: {
          consolidationMinSessions: 5,
          consolidationMinHours: 24,
        },
      });

      expect(integration.shouldRunConsolidation(3, 48)).toBe(false);
    });

    it('should return false when hours threshold is not met', () => {
      const integration = new MemoryIntegration({
        config: {
          consolidationMinSessions: 5,
          consolidationMinHours: 24,
        },
      });

      expect(integration.shouldRunConsolidation(10, 12)).toBe(false);
    });

    it('should return false when neither threshold is met', () => {
      const integration = new MemoryIntegration({
        config: {
          consolidationMinSessions: 5,
          consolidationMinHours: 24,
        },
      });

      expect(integration.shouldRunConsolidation(1, 1)).toBe(false);
    });
  });

  describe('getConfig / updateConfig / isEnabled', () => {
    it('should return a copy of config', () => {
      const integration = new MemoryIntegration({});
      const config1 = integration.getConfig();
      const config2 = integration.getConfig();

      expect(config1).toEqual(config2);
      expect(config1).not.toBe(config2);
    });

    it('should update config', () => {
      const integration = new MemoryIntegration({});

      integration.updateConfig({ enabled: false });
      expect(integration.isEnabled()).toBe(false);

      integration.updateConfig({ autoExtract: false });
      const config = integration.getConfig();
      expect(config.autoExtract).toBe(false);
    });

    it('should report enabled state correctly', () => {
      const integration1 = new MemoryIntegration({ config: { enabled: true } });
      expect(integration1.isEnabled()).toBe(true);

      const integration2 = new MemoryIntegration({ config: { enabled: false } });
      expect(integration2.isEnabled()).toBe(false);
    });
  });
});

describe('createMemoryIntegration', () => {
  it('should create a MemoryIntegration instance', () => {
    const integration = createMemoryIntegration({});
    expect(integration).toBeInstanceOf(MemoryIntegration);
  });

  it('should pass options to constructor', () => {
    const integration = createMemoryIntegration({
      projectHash: 'my-project',
      config: { enabled: false },
    });

    expect(integration.isEnabled()).toBe(false);
  });
});
