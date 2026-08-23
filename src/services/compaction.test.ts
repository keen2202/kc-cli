import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  microcompact,
  shouldCompact,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  COMPACTABLE_TOOLS,
} from './compaction/functional';
import type { ChatMessage } from '../query/protocol';
import type { CompactConfig } from './compaction/functional';

function makeMessages(count: number, contentLength: number = 100): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg_${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message ${i}: ${'x'.repeat(contentLength)}`,
    timestamp: Date.now(),
  }));
}

function makeToolMessages(count: number): ChatMessage[] {
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
      toolResults: [{ toolCallId: `tc_${i}`, output: 'x'.repeat(200), isError: false }],
    });
  }
  return messages;
}

describe('Compaction: microcompact', () => {
  it('should not compact when messages are few', () => {
    const messages = makeMessages(4);
    const result = microcompact(messages, 5);
    expect(result.wasCompacted).toBe(false);
    expect(result.method).toBe('none');
    expect(result.tokensSaved).toBe(0);
  });

  it('should compact when there are many messages with tool results', () => {
    const messages = makeToolMessages(10);
    const result = microcompact(messages, 5);
    expect(result.wasCompacted).toBe(true);
    expect(result.method).toBe('microcompact');
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it('should preserve recent messages', () => {
    const messages = makeToolMessages(10);
    const result = microcompact(messages, 5);
    // The last 5+2 messages should be unchanged
    const recentOriginal = messages.slice(-7);
    const recentCompacted = result.messages.slice(-7);
    expect(recentCompacted.length).toBe(recentOriginal.length);
  });

  it('should clear old tool results with placeholder', () => {
    const messages = makeToolMessages(10);
    const result = microcompact(messages, 5);
    // Find tool role messages in the compacted (non-recent) portion
    const oldToolMessages = result.messages.slice(0, -7).filter(m => m.role === 'tool');
    for (const msg of oldToolMessages) {
      if (msg.toolResults) {
        for (const tr of msg.toolResults) {
          if (tr.output.length > 50) {
            expect(tr.output).toContain('[Old tool result content cleared');
          }
        }
      }
    }
  });
});

describe('Compaction: shouldCompact', () => {
  const config: CompactConfig = {
    contextWindow: 200_000,
    model: 'test',
  };

  it('should return false when token count is below threshold', () => {
    const messages = makeMessages(5, 100);
    expect(shouldCompact(messages, config, 0)).toBe(false);
  });

  it('should return true when token count exceeds threshold', () => {
    // Create enough messages to exceed threshold
    const messages = makeMessages(500, 1000);
    expect(shouldCompact(messages, config, 0)).toBe(true);
  });

  it('should return false after too many consecutive failures', () => {
    const messages = makeMessages(500, 1000);
    expect(shouldCompact(messages, config, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES)).toBe(false);
  });

  it('should return true with failures below limit', () => {
    const messages = makeMessages(500, 1000);
    expect(shouldCompact(messages, config, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1)).toBe(true);
  });
});

describe('Compaction: COMPACTABLE_TOOLS', () => {
  it('should include FileRead', () => {
    expect(COMPACTABLE_TOOLS.has('FileRead')).toBe(true);
  });

  it('should include Bash', () => {
    expect(COMPACTABLE_TOOLS.has('Bash')).toBe(true);
  });

  it('should include Grep', () => {
    expect(COMPACTABLE_TOOLS.has('Grep')).toBe(true);
  });

  it('should not include non-compactable tools', () => {
    expect(COMPACTABLE_TOOLS.has('AskUser')).toBe(false);
  });
});
