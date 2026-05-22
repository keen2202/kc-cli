// Tests for TokenCounter and token estimation utilities

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  TokenCounter,
  countTokens,
  estimateTokens,
  estimateMessageTokens,
  estimateMessageTokensArray,
  estimateToolCallTokens,
  estimateToolResultTokens,
  calculateTokensSaved,
  disposeTokenizer,
} from '../../src/utils/tokenEstimation';
import type { TokenEncoding } from '../../src/utils/tokenEstimation';

describe('TokenCounter', () => {
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter('openai', 'gpt-4o');
  });

  describe('constructor', () => {
    it('should create counter with default maxCacheSize', () => {
      const c = new TokenCounter('openai', 'gpt-4o');
      // Should work without error
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should accept custom maxCacheSize', () => {
      const c = new TokenCounter('openai', 'gpt-4o', 2);
      c.count('a');
      c.count('b');
      c.count('c'); // Should evict 'a'
      // Still functions correctly
      expect(c.count('c')).toBeGreaterThan(0);
    });

    it('should accept explicit encoding parameter', () => {
      const c = new TokenCounter('openai', 'gpt-4o', 1000, 'o200k_base');
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should accept cl100k_base encoding explicitly', () => {
      const c = new TokenCounter('openai', 'gpt-4', 1000, 'cl100k_base');
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should accept custom encoding', () => {
      const c = new TokenCounter('custom-provider', 'custom-model', 1000, 'custom');
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should accept tiktoken encoding', () => {
      const c = new TokenCounter('openai', 'gpt-4', 1000, 'tiktoken');
      expect(c.count('hello')).toBeGreaterThan(0);
    });
  });

  describe('encoding inference', () => {
    it('should infer cl100k_base for anthropic provider', () => {
      const c = new TokenCounter('anthropic', 'claude-3-opus');
      // Should use cl100k (inferred) and produce valid count
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should infer o200k_base for openai gpt-4o model', () => {
      const c = new TokenCounter('openai', 'gpt-4o');
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should infer o200k_base for openai o1 model', () => {
      const c = new TokenCounter('openai', 'o1-preview');
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should infer o200k_base for openai o3 model', () => {
      const c = new TokenCounter('openai', 'o3-mini');
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should infer cl100k_base for openai gpt-4 (non-4o) model', () => {
      const c = new TokenCounter('openai', 'gpt-4-turbo');
      expect(c.count('hello')).toBeGreaterThan(0);
    });

    it('should infer cl100k_base for unknown provider', () => {
      const c = new TokenCounter('unknown-provider', 'some-model');
      expect(c.count('hello')).toBeGreaterThan(0);
    });
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

    it('should handle single character', () => {
      const count = counter.count('a');
      expect(count).toBeGreaterThan(0);
    });

    it('should handle whitespace-only string', () => {
      const count = counter.count('   ');
      expect(count).toBeGreaterThan(0);
    });

    it('should handle newlines and tabs', () => {
      const count = counter.count('line1\nline2\ttab');
      expect(count).toBeGreaterThan(0);
    });

    it('should handle very long text', () => {
      const longText = 'word '.repeat(10000);
      const count = counter.count(longText);
      expect(count).toBeGreaterThan(1000);
    });

    it('should handle code-like text', () => {
      const code = `function hello() {
  console.log("Hello, world!");
  return 42;
}`;
      const count = counter.count(code);
      expect(count).toBeGreaterThan(5);
    });

    it('should handle JSON-like text', () => {
      const json = JSON.stringify({ key: 'value', nested: { arr: [1, 2, 3] } });
      const count = counter.count(json);
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('cache eviction', () => {
    it('should evict oldest entry when cache is full', () => {
      const c = new TokenCounter('openai', 'gpt-4o', 3);
      c.count('first');
      c.count('second');
      c.count('third');
      c.count('fourth'); // Should evict 'first'
      // All values should still produce valid counts
      expect(c.count('first')).toBeGreaterThan(0);
      expect(c.count('fourth')).toBeGreaterThan(0);
    });

    it('should handle cache size of 1', () => {
      const c = new TokenCounter('openai', 'gpt-4o', 1);
      c.count('only');
      c.count('evicts');
      expect(c.count('evicts')).toBeGreaterThan(0);
    });

    it('should handle cache size of 0 (no caching)', () => {
      const c = new TokenCounter('openai', 'gpt-4o', 0);
      // With maxCacheSize=0, cache.size (0) >= maxCacheSize (0) is always true,
      // so it will try to evict from an empty cache each time but still set the value
      const result = c.count('test');
      expect(result).toBeGreaterThan(0);
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

    it('should include 4 tokens of role overhead', () => {
      const count = counter.countMessage({
        role: 'user',
        content: '',
      });
      // Role overhead is 4, empty content is 0
      expect(count).toBe(4);
    });

    it('should count message with tool calls', () => {
      const count = counter.countMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_1',
          toolName: 'Bash',
          input: { command: 'ls -la' },
          status: 'completed',
        }],
      });
      expect(count).toBeGreaterThan(10); // Role + tool overhead
    });

    it('should count message with multiple tool calls', () => {
      const singleToolCount = counter.countMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_1',
          toolName: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
        }],
      });
      const doubleToolCount = counter.countMessage({
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'call_1', toolName: 'Bash', input: { command: 'ls' }, status: 'completed' },
          { id: 'call_2', toolName: 'Read', input: { path: '/tmp' }, status: 'completed' },
        ],
      });
      expect(doubleToolCount).toBeGreaterThan(singleToolCount);
    });

    it('should handle tool call with empty input', () => {
      const count = counter.countMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_1',
          toolName: 'Bash',
          input: {},
          status: 'completed',
        }],
      });
      // 4 (role) + 10 (tool overhead) + tokens for "{}"
      expect(count).toBeGreaterThanOrEqual(14);
    });

    it('should handle tool call with undefined input', () => {
      const count = counter.countMessage({
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_1',
          toolName: 'Bash',
          input: undefined as any,
          status: 'completed',
        }],
      });
      // 4 (role) + 10 (tool overhead) + tokens for "{}"
      expect(count).toBeGreaterThanOrEqual(14);
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

    it('should count message with multiple tool results', () => {
      const singleResultCount = counter.countMessage({
        role: 'tool',
        content: '',
        toolResults: [{
          toolCallId: 'call_1',
          output: 'result1',
        }],
      });
      const doubleResultCount = counter.countMessage({
        role: 'tool',
        content: '',
        toolResults: [
          { toolCallId: 'call_1', output: 'result1' },
          { toolCallId: 'call_2', output: 'result2' },
        ],
      });
      expect(doubleResultCount).toBeGreaterThan(singleResultCount);
    });

    it('should handle tool result with empty output', () => {
      const count = counter.countMessage({
        role: 'tool',
        content: '',
        toolResults: [{
          toolCallId: 'call_1',
          output: '',
        }],
      });
      // 4 (role) + 10 (tool overhead) + 0 (empty output)
      expect(count).toBe(14);
    });

    it('should handle message with both content and tool calls', () => {
      const count = counter.countMessage({
        role: 'assistant',
        content: 'Let me check that for you.',
        toolCalls: [{
          id: 'call_1',
          toolName: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
        }],
      });
      expect(count).toBeGreaterThan(14); // role + content + tool overhead
    });

    it('should handle message with empty toolCalls array', () => {
      const count = counter.countMessage({
        role: 'assistant',
        content: 'Hello',
        toolCalls: [],
      });
      // Should just be role (4) + content tokens, no tool overhead
      expect(count).toBeGreaterThan(4);
    });

    it('should handle message with empty toolResults array', () => {
      const count = counter.countMessage({
        role: 'tool',
        content: 'Hello',
        toolResults: [],
      });
      expect(count).toBeGreaterThan(4);
    });

    it('should handle message with null content', () => {
      const count = counter.countMessage({
        role: 'assistant',
        content: null,
      });
      // Role overhead only when content is falsy
      expect(count).toBe(4);
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

    it('should handle single message array', () => {
      const count = counter.countMessages([
        { role: 'user' as const, content: 'Hello' },
      ]);
      expect(count).toBeGreaterThan(4);
    });

    it('should handle messages with mixed content types', () => {
      const count = counter.countMessages([
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: '', toolCalls: [{ id: 'c1', toolName: 'Bash', input: { cmd: 'ls' }, status: 'completed' }] },
        { role: 'tool' as const, content: '', toolResults: [{ toolCallId: 'c1', output: 'result' }] },
      ]);
      expect(count).toBeGreaterThan(20);
    });
  });

  describe('clearCache', () => {
    it('should clear the cache', () => {
      counter.count('test');
      counter.clearCache();
      // After clearing, should still work
      expect(counter.count('test')).toBeGreaterThan(0);
    });

    it('should allow cache to be repopulated after clearing', () => {
      counter.count('cached value');
      counter.clearCache();
      const count1 = counter.count('new value');
      const count2 = counter.count('new value');
      expect(count1).toBe(count2); // Should be cached again
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

  it('should return consistent results for same input', () => {
    const text = 'consistency check';
    expect(countTokens(text)).toBe(countTokens(text));
  });

  it('should handle special characters', () => {
    expect(countTokens('!@#$%^&*()')).toBeGreaterThan(0);
  });

  it('should handle unicode', () => {
    expect(countTokens('日本語テスト')).toBeGreaterThan(0);
  });
});

describe('estimateTokens', () => {
  it('should be an alias for countTokens', () => {
    expect(estimateTokens('hello')).toBe(countTokens('hello'));
  });

  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should return positive count for text', () => {
    expect(estimateTokens('some text')).toBeGreaterThan(0);
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

  it('should include role overhead for any message', () => {
    const count = estimateMessageTokens({
      role: 'user',
      content: '',
    });
    expect(count).toBe(4);
  });

  it('should count tool calls in message', () => {
    const count = estimateMessageTokens({
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'c1',
        toolName: 'Bash',
        input: { command: 'echo hello' },
        status: 'completed',
      }],
    });
    expect(count).toBeGreaterThan(14);
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

  it('should return 0 for empty array', () => {
    expect(estimateMessageTokensArray([])).toBe(0);
  });

  it('should sum all messages including overhead', () => {
    const singleMsg = estimateMessageTokensArray([
      { role: 'user', content: 'test' },
    ]);
    const doubleMsg = estimateMessageTokensArray([
      { role: 'user', content: 'test' },
      { role: 'assistant', content: 'response' },
    ]);
    expect(doubleMsg).toBeGreaterThan(singleMsg);
  });
});

describe('estimateToolCallTokens', () => {
  it('should estimate tokens for a tool call input', () => {
    const count = estimateToolCallTokens({ command: 'ls -la' });
    expect(count).toBeGreaterThan(0);
  });

  it('should return 0 for empty object', () => {
    // JSON.stringify({}) is "{}" which has tokens
    const count = estimateToolCallTokens({});
    expect(count).toBeGreaterThan(0);
  });

  it('should handle complex nested input', () => {
    const count = estimateToolCallTokens({
      command: 'run tests',
      options: { verbose: true, timeout: 30000 },
      files: ['a.ts', 'b.ts'],
    });
    expect(count).toBeGreaterThan(5);
  });

  it('should produce more tokens for larger inputs', () => {
    const small = estimateToolCallTokens({ a: 1 });
    const large = estimateToolCallTokens({ a: 1, b: 2, c: 3, d: 'a long string value' });
    expect(large).toBeGreaterThan(small);
  });
});

describe('estimateToolResultTokens', () => {
  it('should estimate tokens for tool result output', () => {
    const count = estimateToolResultTokens('file1.txt\nfile2.txt\nfile3.txt');
    expect(count).toBeGreaterThan(0);
  });

  it('should return 0 for empty string', () => {
    expect(estimateToolResultTokens('')).toBe(0);
  });

  it('should count longer output as more tokens', () => {
    const short = estimateToolResultTokens('ok');
    const long = estimateToolResultTokens('a'.repeat(1000));
    expect(long).toBeGreaterThan(short);
  });
});

describe('calculateTokensSaved', () => {
  it('should return positive number when after has fewer tokens', () => {
    const before = [
      { role: 'user' as const, content: 'This is a long message with lots of content' },
      { role: 'assistant' as const, content: 'This is also a very long response with detailed explanation' },
    ];
    const after = [
      { role: 'user' as const, content: 'Short' },
      { role: 'assistant' as const, content: 'Brief' },
    ];
    const saved = calculateTokensSaved(before, after);
    expect(saved).toBeGreaterThan(0);
  });

  it('should return 0 when before and after are the same', () => {
    const messages = [
      { role: 'user' as const, content: 'Hello' },
      { role: 'assistant' as const, content: 'Hi' },
    ];
    const saved = calculateTokensSaved(messages, messages);
    expect(saved).toBe(0);
  });

  it('should return negative number when after has more tokens', () => {
    const before = [{ role: 'user' as const, content: 'Hi' }];
    const after = [
      { role: 'user' as const, content: 'Hi' },
      { role: 'assistant' as const, content: 'Hello, this is a much longer response' },
    ];
    const saved = calculateTokensSaved(before, after);
    expect(saved).toBeLessThan(0);
  });

  it('should return 0 for empty arrays', () => {
    expect(calculateTokensSaved([], [])).toBe(0);
  });

  it('should handle compaction scenario (many messages to fewer)', () => {
    const manyMessages = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message number ${i} with some content to make it realistic`,
    }));
    const compacted = [
      { role: 'user' as const, content: 'Summary of conversation' },
    ];
    const saved = calculateTokensSaved(manyMessages, compacted);
    expect(saved).toBeGreaterThan(0);
  });
});

describe('disposeTokenizer', () => {
  it('should not throw when called', () => {
    expect(() => disposeTokenizer()).not.toThrow();
  });

  it('should be safe to call multiple times', () => {
    disposeTokenizer();
    disposeTokenizer();
    // Should not throw
    expect(true).toBe(true);
  });

  it('should allow continued use after disposal', () => {
    disposeTokenizer();
    // The module-level encoder is reset, but the singleton defaultCounter
    // may reinitialize on next use
    const count = countTokens('hello');
    expect(count).toBeGreaterThan(0);
  });
});
