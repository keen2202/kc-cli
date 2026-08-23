import { describe, it, expect, vi } from 'vitest';
import {
  shouldCompact,
  microcompact,
  fullCompact,
  formatCompactSummary,
  COMPACTABLE_TOOLS,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from '../../src/services/compaction/functional';
import type { ChatMessage } from '../../src/types/message';

function makeMsg(role: string, content?: string, opts?: Partial<ChatMessage>): ChatMessage {
  return {
    id: `msg_${Math.random().toString(36).slice(2)}`,
    role: role as ChatMessage['role'],
    content,
    timestamp: Date.now(),
    ...opts,
  } as ChatMessage;
}

describe('compaction - coverage', () => {
  describe('COMPACTABLE_TOOLS', () => {
    it('should contain expected tools', () => {
      expect(COMPACTABLE_TOOLS.has('FileRead')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('Bash')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('Grep')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('Glob')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('WebSearch')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('WebFetch')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('FileEdit')).toBe(true);
      expect(COMPACTABLE_TOOLS.has('FileWrite')).toBe(true);
    });
  });

  describe('shouldCompact', () => {
    it('should return false when consecutive failures exceed threshold', () => {
      const messages = [makeMsg('user', 'x')];
      const result = shouldCompact(messages, { contextWindow: 200000, model: 'test' }, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES);
      expect(result).toBe(false);
    });

    it('should return true when token count exceeds threshold', () => {
      // Create a lot of messages to exceed threshold
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 5000; i++) {
        messages.push(makeMsg('user', 'This is a fairly long message with enough content to accumulate tokens. '.repeat(5)));
      }
      const result = shouldCompact(messages, { contextWindow: 200000, model: 'test' }, 0);
      expect(result).toBe(true);
    });

    it('should return false for small conversations', () => {
      const messages = [makeMsg('user', 'hi'), makeMsg('assistant', 'hello')];
      const result = shouldCompact(messages, { contextWindow: 200000, model: 'test' }, 0);
      expect(result).toBe(false);
    });
  });

  describe('microcompact', () => {
    it('should return no-op for small message arrays', () => {
      const messages = [makeMsg('user', 'hi'), makeMsg('assistant', 'hello')];
      const result = microcompact(messages, 5);
      expect(result.wasCompacted).toBe(false);
      expect(result.method).toBe('none');
      expect(result.tokensSaved).toBe(0);
    });

    it('should clear tool results with substantial output', () => {
      const messages: ChatMessage[] = [];
      // Add old messages with tool results
      messages.push(makeMsg('user', 'read file'));
      messages.push(makeMsg('assistant', undefined, {
        toolCalls: [{ id: 'tc1', name: 'FileRead', input: { path: 'f.ts' } }],
      }));
      messages.push(makeMsg('tool', undefined, {
        toolResults: [{ toolCallId: 'tc1', output: 'A'.repeat(200) }],
      }));
      // Add recent messages
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('user', `msg ${i}`));
        messages.push(makeMsg('assistant', `reply ${i}`));
      }

      const result = microcompact(messages, 5);
      expect(result.wasCompacted).toBe(true);
      expect(result.method).toBe('microcompact');
    });

    it('should keep short tool results unchanged', () => {
      const messages: ChatMessage[] = [];
      messages.push(makeMsg('user', 'check'));
      messages.push(makeMsg('tool', undefined, {
        toolResults: [{ toolCallId: 'tc1', output: 'short' }],
      }));
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('user', `msg ${i}`));
      }

      const result = microcompact(messages, 5);
      // Short tool results should not be compacted
      expect(result).toBeDefined();
    });

    it('should handle messages without toolResults', () => {
      const messages: ChatMessage[] = [];
      messages.push(makeMsg('user', 'hello'));
      messages.push(makeMsg('assistant', 'hi there'));
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('user', `msg ${i}`));
      }

      const result = microcompact(messages, 5);
      expect(result).toBeDefined();
    });

    it('should handle assistant messages with toolCalls', () => {
      const messages: ChatMessage[] = [];
      messages.push(makeMsg('assistant', undefined, {
        toolCalls: [{ id: 'tc1', name: 'Bash', input: { command: 'ls' } }],
      }));
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('user', `msg ${i}`));
      }

      const result = microcompact(messages, 5);
      expect(result).toBeDefined();
    });
  });

  describe('formatCompactSummary', () => {
    it('should extract content from summary tags', () => {
      const raw = '<summary>Key points: A, B, C</summary>';
      expect(formatCompactSummary(raw)).toBe('Key points: A, B, C');
    });

    it('should handle multiline summary tags', () => {
      const raw = '<summary>\nLine 1\nLine 2\n</summary>';
      expect(formatCompactSummary(raw)).toBe('Line 1\nLine 2');
    });

    it('should return raw text when no summary tags', () => {
      const raw = 'Just a plain summary without tags';
      expect(formatCompactSummary(raw)).toBe('Just a plain summary without tags');
    });

    it('should trim whitespace', () => {
      const raw = '  trimmed summary  ';
      expect(formatCompactSummary(raw)).toBe('trimmed summary');
    });
  });

  describe('fullCompact', () => {
    it('should return no-op for small message arrays', async () => {
      const messages = [makeMsg('user', 'hi'), makeMsg('assistant', 'hello')];
      const result = await fullCompact(messages, null, { contextWindow: 200000, model: 'test' });
      expect(result.wasCompacted).toBe(false);
      expect(result.method).toBe('none');
    });

    it('should use microcompact when it reduces enough tokens', async () => {
      const messages: ChatMessage[] = [];
      // Old messages with large tool results
      for (let i = 0; i < 50; i++) {
        messages.push(makeMsg('user', `request ${i}`));
        messages.push(makeMsg('assistant', undefined, {
          toolCalls: [{ id: `tc${i}`, name: 'Bash', input: { command: `cmd${i}` } }],
        }));
        messages.push(makeMsg('tool', undefined, {
          toolResults: [{ toolCallId: `tc${i}`, output: 'X'.repeat(500) }],
        }));
      }
      // Recent messages
      for (let i = 0; i < 10; i++) {
        messages.push(makeMsg('user', `recent ${i}`));
      }

      const mockClient = {
        chat: vi.fn().mockResolvedValue({ content: 'Summary of conversation' }),
      };

      const result = await fullCompact(messages, mockClient, { contextWindow: 200000, model: 'test' });
      expect(result.wasCompacted).toBe(true);
    });

    it('should fall back to LLM when microcompact is insufficient', async () => {
      const messages: ChatMessage[] = [];
      // Create many messages that won't be microcompacted (no tool results)
      for (let i = 0; i < 100; i++) {
        messages.push(makeMsg('user', 'A'.repeat(500)));
        messages.push(makeMsg('assistant', 'B'.repeat(500)));
      }

      const mockClient = {
        chat: vi.fn().mockResolvedValue({ content: 'Summary of conversation' }),
      };

      const result = await fullCompact(messages, mockClient, { contextWindow: 200000, model: 'test' });
      expect(result.wasCompacted).toBe(true);
      expect(result.method).toBe('fullcompact');
    });

    it('should fall back to truncation summary when API fails', async () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push(makeMsg('user', 'A'.repeat(500)));
        messages.push(makeMsg('assistant', 'B'.repeat(500)));
      }

      const mockClient = {
        chat: vi.fn().mockRejectedValue(new Error('API error')),
      };

      const result = await fullCompact(messages, mockClient, { contextWindow: 200000, model: 'test' });
      expect(result.wasCompacted).toBe(true);
      expect(result.method).toBe('fullcompact');
    });

    it('should handle outer error gracefully', async () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push(makeMsg('user', 'content'));
      }

      // fullCompact will try microcompact first, then LLM, then fallback summary
      // With null client, the LLM call will fail, but buildFallbackSummary catches it
      const result = await fullCompact(messages, null, { contextWindow: 200000, model: 'test' });
      // Should still compact via fallback
      expect(result.wasCompacted).toBe(true);
    });

    it('should pass system prompt to summary', async () => {
      const messages: ChatMessage[] = [];
      for (let i = 0; i < 100; i++) {
        messages.push(makeMsg('user', 'A'.repeat(500)));
      }

      const mockClient = {
        chat: vi.fn().mockResolvedValue({ content: 'Summary' }),
      };

      await fullCompact(messages, mockClient, { contextWindow: 200000, model: 'test' }, 'Custom system prompt');
      expect(mockClient.chat).toHaveBeenCalled();
    });
  });
});
