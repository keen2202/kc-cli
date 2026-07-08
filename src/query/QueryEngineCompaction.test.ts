import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatMessage } from '../query/protocol';
import type { BaseApiClient } from '../api';

// Mock fullCompact so that tests never make real LLM calls
vi.mock('../services/compaction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/compaction')>();
  return { ...actual, fullCompact: vi.fn() };
});

// Import AFTER the mock is set up
import { CompactionHandler } from './QueryEngineCompaction';
import { fullCompact } from '../services/compaction';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg_${i}`,
    role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Message ${i}`,
    timestamp: Date.now(),
  }));
}

const defaultConfig = {
  contextWindow: 200_000,
  model: 'test-model',
};

const mockApiClient = {} as BaseApiClient;

// ── Tests ────────────────────────────────────────────────────────────────

describe('CompactionHandler async compaction', () => {
  let handler: CompactionHandler;

  beforeEach(() => {
    handler = new CompactionHandler();
    vi.clearAllMocks();
  });

  // ── AC-P6.1: Non-blocking ──────────────────────────────────────────

  it('triggerFullCompactAsync returns immediately (< 50 ms)', () => {
    const messages = makeMessages(50);
    const start = performance.now();
    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('does not await the LLM call — drain returns null before completion', () => {
    const messages = makeMessages(50);
    // Delay resolution so we can observe the pending state
    let resolve!: (v: unknown) => void;
    (fullCompact as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise(r => { resolve = r; }),
    );

    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);

    // Immediately after trigger, should NOT be ready
    expect(handler.drainPendingCompactResult([])).toBeNull();
    expect(fullCompact).toHaveBeenCalledTimes(1);

    // Resolve the pending promise
    resolve({
      messages: makeMessages(5),
      tokensSaved: 500,
      wasCompacted: true,
      method: 'fullcompact',
    });
  });

  // ── Promise caching ─────────────────────────────────────────────────

  it('caches the compaction promise — duplicate triggers are no-ops', () => {
    const messages = makeMessages(50);
    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);
    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);
    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);
    expect(fullCompact).toHaveBeenCalledTimes(1);
  });

  // ── Result eventually applied ──────────────────────────────────────

  it('drainPendingCompactResult returns merged result after completion', async () => {
    const messages = makeMessages(50);
    const compacted = [
      {
        id: 'compact_summary',
        role: 'user' as const,
        content: '<conversation_summary>Summary</conversation_summary>',
        timestamp: Date.now(),
      },
      ...messages.slice(-6),
    ];

    (fullCompact as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: compacted,
      tokensSaved: 5000,
      wasCompacted: true,
      method: 'fullcompact',
    });

    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);

    // Wait for the async micro-task to complete
    await new Promise(resolve => setTimeout(resolve, 5));

    const result = handler.drainPendingCompactResult(messages);
    expect(result).not.toBeNull();
    expect(result!.method).toBe('fullcompact');
  });

  it('merges messages added after trigger into the compacted result', async () => {
    const triggerMessages = makeMessages(10); // 10 messages at trigger time
    const compacted = [
      {
        id: 'compact_summary',
        role: 'user' as const,
        content: '<conversation_summary>Summary</conversation_summary>',
        timestamp: Date.now(),
      },
      ...triggerMessages.slice(-6),
    ];

    (fullCompact as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: compacted,
      tokensSaved: 2000,
      wasCompacted: true,
      method: 'fullcompact',
    });

    handler.triggerFullCompactAsync(triggerMessages, mockApiClient, defaultConfig);

    // Simulate 2 new messages being added while compaction was running
    const newMessages: ChatMessage[] = [
      { id: 'new_1', role: 'assistant', content: 'I will fix this', timestamp: Date.now() },
      { id: 'new_2', role: 'user', content: 'continue working', timestamp: Date.now() },
    ];
    const currentMessages = [...triggerMessages, ...newMessages];

    // Wait for async completion
    await new Promise(resolve => setTimeout(resolve, 5));

    const result = handler.drainPendingCompactResult(currentMessages);
    expect(result).not.toBeNull();

    // The merged result should contain compacted messages + the 2 new messages
    expect(result!.messages.length).toBe(compacted.length + newMessages.length);
    // Last two messages should be the new ones
    expect(result!.messages[result!.messages.length - 2].id).toBe('new_1');
    expect(result!.messages[result!.messages.length - 1].id).toBe('new_2');
  });

  // ── No compaction needed ───────────────────────────────────────────

  it('drainPendingCompactResult returns null when compaction produced no result', async () => {
    const messages = makeMessages(50);

    (fullCompact as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages,
      tokensSaved: 0,
      wasCompacted: false,
      method: 'none',
    });

    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);
    await new Promise(resolve => setTimeout(resolve, 5));

    const result = handler.drainPendingCompactResult(messages);
    expect(result).toBeNull();
  });

  // ── Error handling ─────────────────────────────────────────────────

  it('drainPendingCompactResult returns null when compaction throws', async () => {
    const messages = makeMessages(50);

    (fullCompact as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('API error'),
    );

    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);
    await new Promise(resolve => setTimeout(resolve, 5));

    const result = handler.drainPendingCompactResult(messages);
    expect(result).toBeNull();
  });

  // ── Reset ──────────────────────────────────────────────────────────

  it('reset() clears pending state so subsequent triggers start fresh', async () => {
    const messages = makeMessages(50);

    (fullCompact as ReturnType<typeof vi.fn>).mockResolvedValue({
      messages: makeMessages(5),
      tokensSaved: 5000,
      wasCompacted: true,
      method: 'fullcompact',
    });

    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);
    handler.reset();

    // After reset, drain should return null (no pending state)
    expect(handler.drainPendingCompactResult([])).toBeNull();

    // And a new trigger should start a new fullCompact call
    handler.triggerFullCompactAsync(messages, mockApiClient, defaultConfig);
    expect(fullCompact).toHaveBeenCalledTimes(2);
  });
});
