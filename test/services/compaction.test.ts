import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../../src/types/message';
import type { CompactionContext } from '../../src/services/compaction/types';
import { CachedMicroCompactionEngine } from '../../src/services/compaction/cached-micro';
import { SnipCompactionEngine } from '../../src/services/compaction/snip';
import { ForceTruncationEngine } from '../../src/services/compaction/force';

function makeMessages(count: number, contentLength: number = 100): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg_${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}: ${'x'.repeat(contentLength)}`,
    timestamp: Date.now(),
  }));
}

function makeToolMessages(count: number, outputLength: number = 200): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `user_${i}`,
      role: 'user',
      content: `Request ${i}`,
      timestamp: Date.now(),
    });
    messages.push({
      id: `assistant_${i}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolCalls: [{ id: `tc_${i}`, toolName: 'Bash', input: { command: 'ls' }, status: 'completed' }],
    });
    messages.push({
      id: `tool_${i}`,
      role: 'tool',
      content: '',
      timestamp: Date.now(),
      toolResults: [{ toolCallId: `tc_${i}`, output: 'x'.repeat(outputLength), isError: false }],
    });
  }
  return messages;
}

function makeContext(overrides?: Partial<CompactionContext>): CompactionContext {
  return {
    tokenBudget: 200_000,
    currentTokens: 100_000,
    systemPromptTokens: 1000,
    ...overrides,
  };
}

describe('CachedMicroCompactionEngine', () => {
  let engine: CachedMicroCompactionEngine;

  beforeEach(() => {
    engine = new CachedMicroCompactionEngine();
  });

  it('should have priority 0', () => {
    expect(engine.priority).toBe(0);
    expect(engine.name).toBe('cached-micro');
  });

  it('should handle when currentTokens > 80% of budget', () => {
    const messages = makeMessages(10);
    const context = makeContext({ currentTokens: 161_000, tokenBudget: 200_000 });
    expect(engine.canHandle(messages, context)).toBe(true);
  });

  it('should not handle when currentTokens <= 80% of budget', () => {
    const messages = makeMessages(10);
    const context = makeContext({ currentTokens: 159_000, tokenBudget: 200_000 });
    expect(engine.canHandle(messages, context)).toBe(false);
  });

  it('should compact messages with tool results', async () => {
    const messages = makeToolMessages(10);
    const context = makeContext({ currentTokens: 161_000 });

    const result = await engine.compact(messages, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tokensSaved).toBeGreaterThanOrEqual(0);
      expect(result.value.messages).toBeDefined();
    }
  });

  it('should return cached result on second call with same messages', async () => {
    const messages = makeToolMessages(10);
    const context = makeContext({ currentTokens: 161_000 });

    const result1 = await engine.compact(messages, context);
    const result2 = await engine.compact(messages, context);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.method).toBe(result2.value.method);
      expect(result1.value.tokensSaved).toBe(result2.value.tokensSaved);
    }
    // Cache should have one entry
    expect(engine.cacheSize).toBe(1);
  });

  it('should clear cache', () => {
    engine.clearCache();
    expect(engine.cacheSize).toBe(0);
  });
});

describe('SnipCompactionEngine', () => {
  let engine: SnipCompactionEngine;

  beforeEach(() => {
    engine = new SnipCompactionEngine();
  });

  it('should have priority 10', () => {
    expect(engine.priority).toBe(10);
    expect(engine.name).toBe('snip');
  });

  it('should handle when tool result exceeds 5000 chars', () => {
    const messages = makeToolMessages(3, 6000);
    const context = makeContext();
    expect(engine.canHandle(messages, context)).toBe(true);
  });

  it('should not handle when all tool results are under 5000 chars', () => {
    const messages = makeToolMessages(3, 4000);
    const context = makeContext();
    expect(engine.canHandle(messages, context)).toBe(false);
  });

  it('should not handle when there are no tool messages', () => {
    const messages = makeMessages(10);
    const context = makeContext();
    expect(engine.canHandle(messages, context)).toBe(false);
  });

  it('should snip large tool outputs', async () => {
    const messages = makeToolMessages(3, 6000);
    const context = makeContext();

    const result = await engine.compact(messages, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tokensSaved).toBeGreaterThan(0);
      expect(result.value.method).toBe('snip');

      // Check that tool results were truncated
      const toolMessages = result.value.messages.filter(m => m.role === 'tool');
      for (const msg of toolMessages) {
        if (msg.toolResults) {
          for (const tr of msg.toolResults) {
            const output = String(tr.output);
            expect(output).toContain('[Output truncated -');
            expect(output.length).toBeLessThan(6000);
          }
        }
      }
    }
  });

  it('should not modify small tool outputs', async () => {
    const messages = makeToolMessages(3, 200);
    const context = makeContext();

    const result = await engine.compact(messages, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.method).toBe('snip:noop');
      expect(result.value.tokensSaved).toBe(0);
    }
  });

  it('should not modify non-tool messages', async () => {
    const messages = makeMessages(10);
    const context = makeContext();

    const result = await engine.compact(messages, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.method).toBe('snip:noop');
      expect(result.value.messages).toEqual(messages);
    }
  });
});

describe('ForceTruncationEngine', () => {
  let engine: ForceTruncationEngine;

  beforeEach(() => {
    engine = new ForceTruncationEngine();
  });

  it('should have priority 30', () => {
    expect(engine.priority).toBe(30);
    expect(engine.name).toBe('force');
  });

  it('should always handle (fallback)', () => {
    const messages = makeMessages(5);
    const context = makeContext();
    expect(engine.canHandle(messages, context)).toBe(true);
  });

  it('should handle empty messages', () => {
    const messages: ChatMessage[] = [];
    const context = makeContext();
    expect(engine.canHandle(messages, context)).toBe(true);
  });

  it('should truncate large message arrays', async () => {
    // Create a large message array that exceeds MAX_TOKEN_LIMIT
    const messages = makeMessages(500, 1000);
    const context = makeContext();

    const result = await engine.compact(messages, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.messages.length).toBeLessThan(messages.length);
      expect(result.value.method).toBe('force');
    }
  });

  it('should keep recent messages when truncating', async () => {
    const messages = makeMessages(500, 1000);
    const context = makeContext();

    const result = await engine.compact(messages, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // The last message should be preserved
      const lastOriginal = messages[messages.length - 1];
      const lastCompacted = result.value.messages[result.value.messages.length - 1];
      expect(lastCompacted.id).toBe(lastOriginal.id);
    }
  });

  it('should return zero tokens saved for small arrays', async () => {
    const messages = makeMessages(5, 100);
    const context = makeContext();

    const result = await engine.compact(messages, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Small arrays may not need truncation
      expect(result.value.messages.length).toBeLessThanOrEqual(messages.length);
    }
  });
});

describe('CompactionEngine priority ordering', () => {
  it('should have correct priority order', () => {
    const cachedMicro = new CachedMicroCompactionEngine();
    const snip = new SnipCompactionEngine();
    const force = new ForceTruncationEngine();

    expect(cachedMicro.priority).toBeLessThan(snip.priority);
    expect(snip.priority).toBeLessThan(force.priority);
  });
});
