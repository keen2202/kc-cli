import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractMemoriesFromMessages,
  resetExtractionState,
} from '../../src/services/memoryExtraction';
import type { ChatMessage } from '../../src/types/message';

function makeUserMessage(content: string): ChatMessage {
  return { role: 'user', content };
}

function makeAssistantMessage(content: string): ChatMessage {
  return { role: 'assistant', content };
}

describe('Enhanced Memory Extraction', () => {
  beforeEach(() => {
    resetExtractionState();
  });

  describe('Confidence scoring', () => {
    it('should assign low confidence to regex-extracted memories', async () => {
      const messages = [makeUserMessage('I prefer TypeScript over JavaScript')];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0].header.confidence).toBe('low');
    });

    it('should assign low confidence to project decisions', async () => {
      const messages = [makeUserMessage('We should use PostgreSQL for the database')];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0].header.confidence).toBe('low');
    });

    it('should assign low confidence to feedback', async () => {
      const messages = [makeAssistantMessage("Don't use var, always use const or let")];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0].header.confidence).toBe('low');
    });
  });

  describe('Unique filenames', () => {
    it('should generate unique filenames for multiple extractions', async () => {
      const messages = [
        makeUserMessage('I prefer dark mode'),
        makeUserMessage('I prefer monospace fonts'),
      ];
      const memories = await extractMemoriesFromMessages(messages);

      // Each extraction should have a unique filename
      const fileNames = memories.map(m => m.fileName);
      const uniqueNames = new Set(fileNames);
      expect(uniqueNames.size).toBe(fileNames.length);
    });

    it('should include timestamp in filename', async () => {
      const messages = [makeUserMessage('I prefer vim keybindings for all my editing workflows')];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBeGreaterThan(0);
      // Filename should contain timestamp pattern (digits)
      expect(memories[0].fileName).toMatch(/\d{10,}/);
    });
  });

  describe('Quality checks', () => {
    it('should reject too-short content', async () => {
      // "I prefer x" - extracted part is "x" which is < 20 chars
      const messages = [makeUserMessage('I prefer x')];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBe(0);
    });

    it('should reject code-only content', async () => {
      const codeContent = '```\nconst x = 1;\nconst y = 2;\nconsole.log(x + y);\n```';
      const messages = [makeUserMessage(`We decided to use ${codeContent} for the implementation`)];
      const memories = await extractMemoriesFromMessages(messages);

      // The extracted part would be mostly code
      const nonCodeMemories = memories.filter(m => !m.content.includes('```'));
      // Either rejected or accepted, but code-heavy content should be filtered
      for (const memory of memories) {
        const codeBlocks = memory.content.match(/```[\s\S]*?```/g) || [];
        const codeLength = codeBlocks.reduce((sum, block) => sum + block.length, 0);
        // If code is >50% of content, it should have been rejected
        if (memory.content.length > 0) {
          expect(codeLength / memory.content.length).toBeLessThanOrEqual(0.5);
        }
      }
    });

    it('should accept content with sufficient length', async () => {
      const messages = [makeUserMessage('I prefer using TypeScript for all backend projects')];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0].content.length).toBeGreaterThanOrEqual(20);
    });
  });

  describe('Deduplication', () => {
    it('should prevent exact duplicate content across messages', async () => {
      const messages = [
        makeUserMessage('I prefer using TypeScript for everything'),
        makeUserMessage('I prefer using TypeScript for everything'), // Exact duplicate
      ];
      const memories = await extractMemoriesFromMessages(messages);

      // Should only extract once, not twice
      expect(memories.length).toBe(1);
    });

    it('should detect case-insensitive duplicates', async () => {
      const messages = [
        makeUserMessage('I prefer TypeScript for all backend development'),
        makeUserMessage('I prefer typescript for all backend development'), // Same content, different case
      ];
      const memories = await extractMemoriesFromMessages(messages);

      // Should only extract once
      expect(memories.length).toBe(1);
    });

    it('should allow different content', async () => {
      const messages = [
        makeUserMessage('I prefer TypeScript for all my backend development projects'),
        makeUserMessage('I prefer React framework for all frontend development work'),
      ];
      const memories = await extractMemoriesFromMessages(messages);

      // Both should be extracted since they're different
      expect(memories.length).toBe(2);
    });
  });

  describe('Extraction patterns', () => {
    it('should extract user preferences with various patterns', async () => {
      const messages = [
        makeUserMessage('I like using Docker for containerization'),
        makeUserMessage('My role is senior backend engineer'),
        makeUserMessage('I work in fintech'),
      ];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBeGreaterThanOrEqual(2);
      const types = memories.map(m => m.header.type);
      expect(types).toContain('user');
    });

    it('should extract project decisions', async () => {
      const messages = [
        makeUserMessage('We decided to migrate to microservices architecture'),
        makeUserMessage('The deadline is end of Q2'),
      ];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBeGreaterThanOrEqual(1);
      const projectMemories = memories.filter(m => m.header.type === 'project');
      expect(projectMemories.length).toBeGreaterThanOrEqual(1);
    });

    it('should extract feedback from assistant messages', async () => {
      const messages = [
        makeAssistantMessage("Avoid using `any` type in TypeScript, it defeats the purpose"),
        makeAssistantMessage('Remember that async/await is preferred over .then() chains'),
      ];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBeGreaterThanOrEqual(1);
      const feedbackMemories = memories.filter(m => m.header.type === 'feedback');
      expect(feedbackMemories.length).toBeGreaterThanOrEqual(1);
    });

    it('should not extract from empty or irrelevant messages', async () => {
      const messages = [
        makeUserMessage('ok'),
        makeUserMessage('thanks'),
        makeAssistantMessage('Got it, let me check that for you.'),
      ];
      const memories = await extractMemoriesFromMessages(messages);

      expect(memories.length).toBe(0);
    });
  });
});
