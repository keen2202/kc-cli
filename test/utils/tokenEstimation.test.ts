// Tests for TokenCounter and token estimation utilities

import { describe, it, expect, beforeEach } from 'vitest';
import { TokenCounter, countTokens, estimateTokens, estimateMessageTokens, estimateMessageTokensArray } from '../../src/utils/tokenEstimation';

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter('openai', 'gpt-4o');
  });

  describe('count', () => {
    it('should return 0 for empty string', () => {
      expect(counter.count('')).toBe(0);
    });

    it('should return positive count for non-empty text', () => {
      const count = counter.count('Hello, world!');
      expect(count).toBeGreaterThan(0);
    });

    it('should cache results for repeated calls', () => {
      const text = 'This is a test string for caching';
      const count1 = counter.count(text);
      const count2 = counter.count(text);
      expect(count1).toBe(count2);
    });

    it('should count longer text as more tokens', () => {
      const shortCount = counter.count('hello');
      const longCount = counter.count('hello world this is a much longer piece of text');
      expect(longCount).toBeGreaterThan(shortCount);
    });

    it('should handle special characters', () => {
      const count = counter.count('!@#$%^&*()_+{}|:"<>?');
      expect(count).toBeGreaterThan(0);
    });

    it('should handle unicode', () => {
      const count = counter.count('你好世界 🌍');
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('countMessage', () => {
    it('should count message with content', () => {
      const count = counter.countMessage({
        role: 'user',
        content: 'Hello, how are you?',
      });
      expect(count).toBeGreaterThan(4); // At least role overhead
    });

    it('should count message with tool calls', () => {
      const count = counter.countMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_1',
          name: 'Bash',
          input: { command: 'ls -la' },
        }],
      });
      expect(count).toBeGreaterThan(10); // Role + tool overhead
    });

    it('should count message with tool results', () => {
      const count = counter.countMessage({
        role: 'tool',
        content: '',
        toolResults: [{
          toolCallId: 'call_1',
          output: 'file1.txt\nfile2.txt',
        }],
      });
      expect(count).toBeGreaterThan(10);
    });
  });

  describe('countMessages', () => {
    it('should sum tokens across messages', () => {
      const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there!' },
        { role: 'user' as const, content: 'How are you?' },
      ];
      const count = counter.countMessages(messages);
      expect(count).toBeGreaterThan(12); // At least 4 * 3 for role overhead
    });

    it('should return 0 for empty array', () => {
      expect(counter.countMessages([])).toBe(0);
    });
  });

  describe('clearCache', () => {
    it('should clear the cache', () => {
      counter.count('test');
      counter.clearCache();
      // After clearing, should still work
      expect(counter.count('test')).toBeGreaterThan(0);
    });
  });
});

describe('countTokens', () => {
  it('should return 0 for empty string', () => {
    expect(countTokens('')).toBe(0);
  });

  it('should return positive count for text', () => {
    expect(countTokens('hello world')).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  it('should be an alias for countTokens', () => {
    expect(estimateTokens('hello')).toBe(countTokens('hello'));
  });
});

describe('estimateMessageTokens', () => {
  it('should estimate tokens for a simple message', () => {
    const count = estimateMessageTokens({
      role: 'user',
      content: 'Hello',
    });
    expect(count).toBeGreaterThan(0);
  });
});

describe('estimateMessageTokensArray', () => {
  it('should estimate tokens for multiple messages', () => {
    const count = estimateMessageTokensArray([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ]);
    expect(count).toBeGreaterThan(0);
  });
});
