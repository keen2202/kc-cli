import { describe, it, expect, beforeEach } from 'vitest';
import {
  validateExtractedMemory,
  validateMergedCoherence,
  shouldPruneMemory,
  getMemoriesToPrune,
  filterQualityMemories,
  resetQualityState,
} from '../../src/services/memoryQuality';
import type { MemoryEntry, MemoryManifestEntry } from '../../src/memory/types';

function makeMemory(content: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    header: {
      name: 'test',
      description: 'Test memory',
      type: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    content,
    filePath: '/tmp/test.md',
    fileName: 'test.md',
    mtime: Date.now(),
    ...overrides,
  };
}

function makeManifest(overrides: Partial<MemoryManifestEntry> = {}): MemoryManifestEntry {
  return {
    fileName: 'test.md',
    description: 'Test memory',
    type: 'user',
    mtime: Date.now(),
    ...overrides,
  };
}

describe('Memory Quality Pipeline', () => {
  beforeEach(() => {
    resetQualityState();
  });

  describe('validateExtractedMemory', () => {
    it('should reject content shorter than 20 chars', () => {
      const result = validateExtractedMemory('short');
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('too_short');
    });

    it('should accept content with sufficient length', () => {
      const result = validateExtractedMemory('This is a valid memory with enough content to pass');
      expect(result.pass).toBe(true);
    });

    it('should reject code-only content', () => {
      const codeContent = '```typescript\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n```';
      const result = validateExtractedMemory(codeContent);
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('code_only');
    });

    it('should accept content with some code blocks', () => {
      const mixedContent = 'When implementing the service, use this pattern:\n```\nconst x = 1;\n```\nThis ensures type safety across the module boundary.';
      const result = validateExtractedMemory(mixedContent);
      expect(result.pass).toBe(true);
    });

    it('should handle empty content', () => {
      const result = validateExtractedMemory('');
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('too_short');
    });

    it('should handle whitespace-only content', () => {
      const result = validateExtractedMemory('   \n\t  ');
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('too_short');
    });
  });

  describe('validateMergedCoherence', () => {
    it('should accept coherent merged content', () => {
      const content = 'We prefer TypeScript for all backend services.\nWe also use React for frontend development.';
      const result = validateMergedCoherence(content);
      expect(result.pass).toBe(true);
    });

    it('should detect contradictory statements', () => {
      const content = 'Use PostgreSQL for the database. But also don\'t use PostgreSQL, use MongoDB instead.';
      const result = validateMergedCoherence(content);
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('incoherent');
    });

    it('should reject empty content', () => {
      const result = validateMergedCoherence('');
      expect(result.pass).toBe(false);
      expect(result.reason).toBe('incoherent');
    });

    it('should accept content with contradictions far apart', () => {
      // Contradictions far apart might be legitimate updates
      const content = 'We use PostgreSQL for the main database. This is our primary data store ' +
        'that handles all production workloads and has been running for over two years now. ' +
        'We chose it for its reliability and ACID compliance.\n\n' +
        'A long time ago we used MySQL but migrated away from it.\n\n' +
        'Now we don\'t use MySQL anymore for any of our services.';
      const result = validateMergedCoherence(content);
      expect(result.pass).toBe(true);
    });
  });

  describe('shouldPruneMemory', () => {
    it('should prune memory loaded many times but never referenced', () => {
      const memory = makeManifest({ mtime: Date.now() - 10 * 24 * 60 * 60 * 1000 }); // 10 days old
      const feedback = { loaded: 6, referenced: 0 };

      expect(shouldPruneMemory(memory, feedback)).toBe(true);
    });

    it('should not prune memory that has been referenced', () => {
      const memory = makeManifest({ mtime: Date.now() - 10 * 24 * 60 * 60 * 1000 });
      const feedback = { loaded: 10, referenced: 3 };

      expect(shouldPruneMemory(memory, feedback)).toBe(false);
    });

    it('should not prune memory that is too young', () => {
      const memory = makeManifest({ mtime: Date.now() - 2 * 24 * 60 * 60 * 1000 }); // 2 days old
      const feedback = { loaded: 10, referenced: 0 };

      expect(shouldPruneMemory(memory, feedback)).toBe(false);
    });

    it('should not prune memory with no feedback data', () => {
      const memory = makeManifest({ mtime: Date.now() - 30 * 24 * 60 * 60 * 1000 });

      expect(shouldPruneMemory(memory, null)).toBe(false);
    });

    it('should not prune memory loaded fewer times than threshold', () => {
      const memory = makeManifest({ mtime: Date.now() - 10 * 24 * 60 * 60 * 1000 });
      const feedback = { loaded: 3, referenced: 0 }; // Only loaded 3 times, threshold is 5

      expect(shouldPruneMemory(memory, feedback)).toBe(false);
    });

    it('should respect custom config', () => {
      const memory = makeManifest({ mtime: Date.now() - 10 * 24 * 60 * 60 * 1000 });
      const feedback = { loaded: 3, referenced: 0 };

      // With lower threshold
      expect(shouldPruneMemory(memory, feedback, { sessionsThreshold: 3, minAgeDays: 7 })).toBe(true);
    });
  });

  describe('getMemoriesToPrune', () => {
    it('should return file names of memories to prune', () => {
      const memories = [
        makeManifest({ fileName: 'keep.md', mtime: Date.now() - 10 * 24 * 60 * 60 * 1000 }),
        makeManifest({ fileName: 'prune.md', mtime: Date.now() - 10 * 24 * 60 * 60 * 1000 }),
        makeManifest({ fileName: 'young.md', mtime: Date.now() - 2 * 24 * 60 * 60 * 1000 }),
      ];

      const feedbackMap = new Map([
        ['keep.md', { loaded: 10, referenced: 5 }],
        ['prune.md', { loaded: 8, referenced: 0 }],
        ['young.md', { loaded: 10, referenced: 0 }],
      ]);

      const toPrune = getMemoriesToPrune(memories, feedbackMap);
      expect(toPrune).toContain('prune.md');
      expect(toPrune).not.toContain('keep.md');
      expect(toPrune).not.toContain('young.md');
    });
  });

  describe('filterQualityMemories', () => {
    it('should separate passed and rejected memories', () => {
      const memories = [
        makeMemory('This is a valid memory with enough content'),
        makeMemory('short'),
        makeMemory('Another valid memory that has sufficient content length'),
        makeMemory('```\nonly code here\n```'),
      ];

      const result = filterQualityMemories(memories);

      expect(result.passed.length).toBe(2);
      expect(result.rejected.length).toBe(2);
      expect(result.rejected[0].reason).toBe('too_short');
      expect(result.rejected[1].reason).toBe('code_only');
    });

    it('should pass all valid memories', () => {
      const memories = [
        makeMemory('TypeScript is preferred for all backend services'),
        makeMemory('React is used for frontend development with hooks'),
      ];

      const result = filterQualityMemories(memories);
      expect(result.passed.length).toBe(2);
      expect(result.rejected.length).toBe(0);
    });

    it('should reject all invalid memories', () => {
      const memories = [
        makeMemory('hi'),
        makeMemory('```code```'),
      ];

      const result = filterQualityMemories(memories);
      expect(result.passed.length).toBe(0);
      expect(result.rejected.length).toBe(2);
    });
  });
});
