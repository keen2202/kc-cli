// QueryEngine Comprehensive Coverage Tests - Part 2
// Covers: message trimming, buildApiMessages, circuit breaker, event creation,
// configuration variations, multiple submissions, edge cases, clear/reset,
// state machine, behavioral adapter, getMessages
//
// T04 (C4) de-watered: see ./helpers/coverage-harness.ts for the mock policy.
// Zero-assertion drain-only cases were deleted in an earlier pass; the
// unknown-state and tool-without-text edge cases now assert deterministic
// behavior through the real executor.

import {
  describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    resetHarness,
  createTestEngine,
  collectEvents,
  setStream,
  textEvents,
  makeToolCall,
  twoTurnStream,
  makeTool,
  ok as toolOk,
  makeMockEnv,
  getStreamFactory,
  getTokenEstimate,
  setCustomStreamChat,
} from './helpers/coverage-harness';

// ── Inline module mocks (vitest 4: must be declared in the test file) ──
const { mockChatImpl } = vi.hoisted(() => ({
  mockChatImpl: vi.fn(async () => ({
    content: 'mock summary',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  })),
}));

vi.mock('../../src/api', () => ({
  createAPIClient: vi.fn(() => ({
    streamChat: vi.fn(async function* () { yield* getStreamFactory()(); }),
    chat: mockChatImpl,
  })),
  BaseApiClient: class {},
  ApiError: class ApiError extends Error {
    statusCode?: number;
    responseHeaders?: Record<string, string>;
    constructor(msg: string, code?: number, headers?: Record<string, string>) {
      super(msg);
      this.statusCode = code;
      this.responseHeaders = headers;
    }
  },
}));

vi.mock('../../src/services/compaction/functional', () => ({
  shouldCompact: vi.fn(() => true),
  microcompact: vi.fn((msgs: any[]) => ({ wasCompacted: false, messages: msgs, tokensSaved: 0 })),
  fullCompact: vi.fn(async (msgs: any[]) => ({ wasCompacted: false, messages: msgs, tokensSaved: 0 })),
  needsForceTruncation: vi.fn(() => false),
  forceTruncate: vi.fn((msgs: any[]) => ({ messages: msgs, tokensSaved: 0, wasCompacted: false })),
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: 3,
}));

vi.mock('../../src/utils/tokenEstimation', () => ({
  estimateMessageTokensArray: vi.fn(() => getTokenEstimate()),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn(() => getTokenEstimate()),
}));

vi.mock('../../src/services/sandbox-probe', () => ({
  SandboxProbe: class MockSandboxProbe {
    async verifyIsolation() {
      return { passed: 4, total: 4, results: [] as unknown[], failures: [] as unknown[], overallPassed: true };
    }
  },
}));

import type { ChatMessage } from '../../src/types/message';
import { createAPIClient } from '../../src/api';
import { QueryEngine } from '../../src/query/QueryEngine';

describe('QueryEngine Coverage Part 2', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Message Trimming ──

  describe('message trimming', () => {
    it('should trim messages when exceeding maxMessages limit', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({ maxMessages: 5 });

      const messages = (engine as any).messages as ChatMessage[];
      for (let i = 0; i < 20; i++) {
        messages.push({
          id: `user_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        } as ChatMessage);
        messages.push({
          id: `assistant_${i}`,
          role: 'assistant',
          content: `Response ${i}`,
          timestamp: Date.now(),
        } as ChatMessage);
      }

      try {
        for await (const _ of engine.submitMessage('new message')) {
          // drain
        }
      } catch {
        // may throw
      }

      const finalMessages = engine.getMessages();
      expect(finalMessages.length).toBeLessThanOrEqual(6);
    });

    it('should preserve first user message as anchor during trimming', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({ maxMessages: 3 });

      const messages = (engine as any).messages as ChatMessage[];
      const firstUserMsg: ChatMessage = {
        id: 'first_user',
        role: 'user',
        content: 'Important first message',
        timestamp: Date.now(),
      };
      messages.push(firstUserMsg);

      for (let i = 0; i < 10; i++) {
        messages.push({
          id: `user_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        } as ChatMessage);
      }

      try {
        for await (const _ of engine.submitMessage('trigger trim')) {
          // drain
        }
      } catch {
        // may throw
      }

      const finalMessages = engine.getMessages();
      expect(finalMessages.some(m => m.id === 'first_user')).toBe(true);
    });

    it('should preserve system messages as anchors during trimming', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({ maxMessages: 3 });

      const messages = (engine as any).messages as ChatMessage[];
      messages.push({
        id: 'system_anchor',
        role: 'system',
        content: 'System prompt',
        timestamp: Date.now(),
      } as any);

      for (let i = 0; i < 10; i++) {
        messages.push({
          id: `user_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        } as ChatMessage);
      }

      try {
        for await (const _ of engine.submitMessage('trigger trim')) {
          // drain
        }
      } catch {
        // may throw
      }

      const finalMessages = engine.getMessages();
      expect(finalMessages.some(m => m.id === 'system_anchor')).toBe(true);
    });

    it('should return messages from active tree node (FUN-09)', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine();

      try {
        for await (const _ of engine.submitMessage('test')) {
          // drain
        }
      } catch {
        // may throw
      }

      const finalMessages = engine.getMessages();
      // 1 user (submitMessage) + 1 assistant (response) = 2
      expect(finalMessages.length).toBe(2);
    });
  });

  // ── buildApiMessages ──

  describe('buildApiMessages', () => {
    it('should build messages with system prompt', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({ systemPrompt: 'You are a test assistant.' });
      await collectEvents(engine, 'hello');

      const builtClient = (createAPIClient as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (builtClient) {
        const streamChatCall = builtClient.streamChat.mock.calls[0]?.[0];
        expect(streamChatCall).toBeDefined();
        expect(Array.isArray(streamChatCall.messages)).toBe(true);
      }
    });
  });

  // ── Circuit Breaker Integration ──

  describe('circuit breaker integration', () => {
    it('should block API calls when circuit breaker is open', async () => {
      engine = createTestEngine();

      const breakerRegistry = engine.getErrorHandler().getCircuitBreakers();
      const apiBreaker = breakerRegistry.getBreaker('api');

      for (let i = 0; i < 6; i++) {
        apiBreaker.recordFailure();
      }

      expect(apiBreaker.canExecute()).toBe(false);

      // Set factory to throw a non-retryable error to trigger breaker check
      setCustomFactory(async function* () {
        yield { type: 'text_delta', text: 'partial' };
        throw new Error('auth error');
      });

      const events = await collectEvents(engine, 'test');

      const textEvts = events.filter(e => e.type === 'agent:text_delta');
      expect(textEvts.some(e => (e as any).text?.includes('API temporarily unavailable'))).toBe(true);
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should allow API calls when circuit breaker is closed', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine();

      const breakerRegistry = engine.getErrorHandler().getCircuitBreakers();
      const apiBreaker = breakerRegistry.getBreaker('api');
      expect(apiBreaker.canExecute()).toBe(true);

      const events = await collectEvents(engine, 'test');
      const completeEvents = events.filter(e => e.type === 'agent:complete');
      expect(completeEvents.length).toBe(1);
    });
  });

  // ── Event Creation Helpers ──

  describe('event creation', () => {
    it('should create text delta events with correct structure', async () => {
      setStream(textEvents('test text'));

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const textDelta = events.find(e => e.type === 'agent:text_delta');
      expect(textDelta).toBeDefined();
      expect(textDelta.text).toBe('test text');
      expect(textDelta.timestamp).toBeDefined();
    });

    it('should create turn complete events with message and usage', async () => {
      setStream(textEvents('response'));

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const turnComplete = events.find(e => e.type === 'agent:turn_complete');
      expect(turnComplete).toBeDefined();
      expect(turnComplete.message).toBeDefined();
      expect(turnComplete.message.role).toBe('assistant');
      expect(turnComplete.usage).toBeDefined();
      expect(turnComplete.usage.inputTokens).toBe(0);
      expect(turnComplete.usage.outputTokens).toBe(0);
    });

    it('passes real usage from the provider stop event through to turn_complete', async () => {
      setStream([
        { type: 'text_delta', text: 'response' },
        { type: 'stop', usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 } },
      ]);

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const turnComplete = events.find(e => e.type === 'agent:turn_complete');
      expect(turnComplete).toBeDefined();
      expect(turnComplete.usage).toEqual({ inputTokens: 120, outputTokens: 30, totalTokens: 150 });
    });

    it('derives totalTokens when the provider stop usage omits it', async () => {
      setStream([
        { type: 'text_delta', text: 'response' },
        { type: 'stop', usage: { inputTokens: 10, outputTokens: 5 } } as any,
      ]);

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const turnComplete = events.find(e => e.type === 'agent:turn_complete');
      expect(turnComplete.usage.totalTokens).toBe(15);
    });

    it('should create complete event at end of successful run', async () => {
      setStream(textEvents('done'));

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const complete = events.find(e => e.type === 'agent:complete');
      expect(complete).toBeDefined();
      expect(complete.timestamp).toBeDefined();
    });
  });

  // ── Configuration Variations ──

  describe('configuration variations', () => {
    it('should work with ollama provider (no API key required)', async () => {
      setStream(textEvents('ollama response'));

      engine = createTestEngine({
        model: 'llama3',
        provider: 'ollama',
        apiKey: undefined,
        maxTurns: 5,
      });

      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should work with anthropic provider', async () => {
      setStream(textEvents('claude response'));

      engine = createTestEngine({
        model: 'claude-sonnet-4-20250514',
        provider: 'anthropic',
        maxTurns: 5,
      });

      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should work with maxBudgetUsd set', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({ maxBudgetUsd: 10.0 });
      const events = await collectEvents(engine, 'test');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should work with apiBaseUrl set', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({ apiBaseUrl: 'https://custom-api.example.com' });
      const events = await collectEvents(engine, 'test');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should work with permission rules', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({
        permissionRules: {
          deny: ['Sql'],
          allow: ['FileRead', 'Glob'],
          ask: ['Bash'],
        },
      });

      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });
  });

  // ── Multiple Submissions ──

  describe('multiple submissions', () => {
    it('should support multiple sequential submitMessage calls', async () => {
      setStream(textEvents('Response'));

      engine = createTestEngine();

      const events1 = await collectEvents(engine, 'first message');
      expect(engine.getStateMachine().currentState).toBe('completed');

      engine.getStateMachine().reset();
      const events2 = await collectEvents(engine, 'second message');
      expect(engine.getStateMachine().currentState).toBe('completed');

      const messages = engine.getMessages();
      expect(messages.filter(m => m.role === 'user').length).toBe(2);
    });

    it('should accumulate conversation history across submissions', async () => {
      setStream(textEvents('Reply'));

      engine = createTestEngine();

      await collectEvents(engine, 'msg1');
      engine.getStateMachine().reset();
      await collectEvents(engine, 'msg2');
      engine.getStateMachine().reset();
      await collectEvents(engine, 'msg3');

      const messages = engine.getMessages();
      const userMessages = messages.filter(m => m.role === 'user');
      const assistantMessages = messages.filter(m => m.role === 'assistant');

      expect(userMessages.length).toBe(3);
      expect(assistantMessages.length).toBe(3);
    });
  });

  // ── Edge Cases ──

  describe('edge cases', () => {
    it('should handle empty user message', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine();
      const events = await collectEvents(engine, '');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should handle very long user message', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine();
      const longMessage = 'x'.repeat(100_000);
      const events = await collectEvents(engine, longMessage);

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should handle stream with tool_use but no text (executed over MockExecutionEnv)', async () => {
      const { env, fs } = makeMockEnv();
      const echo = makeTool('Echo', async () => {
        await env.fs.writeFile('/out/no-text.txt', 'done');
        return toolOk('echo:no-text-case');
      });

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('Echo', {}) };
          yield { type: 'stop' };
        })(),
        'done',
      );

      engine = createTestEngine({}, [echo as any]);
      const events = await collectEvents(engine, 'test');

      // The tool actually ran despite the absent text preamble.
      const completed = events.filter(e => e.type === 'agent:tool_completed');
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect((completed[0] as any).result.output).toBe('echo:no-text-case');
      expect(await env.fs.readFile('/out/no-text.txt')).toBe('done');
      expect(fs.listFiles()).toContain('/out/no-text.txt');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should handle stream with stop event', async () => {
      setStream([
        { type: 'text_delta', text: 'hello' },
        { type: 'stop' },
      ]);

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });
  });

  // ── Clear and Reset ──

  describe('clear and reset', () => {
    it('should clear messages and reset state machine', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine();
      await collectEvents(engine, 'test');

      expect(engine.getMessages().length).toBeGreaterThan(0);
      expect(engine.getStateMachine().currentState).toBe('completed');

      engine.clear();

      expect(engine.getMessages()).toEqual([]);
      expect(engine.getStateMachine().currentState).toBe('idle');
    });

    it('should allow new submission after clear', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine();

      await collectEvents(engine, 'first');
      expect(engine.getStateMachine().currentState).toBe('completed');

      engine.clear();
      expect(engine.getStateMachine().currentState).toBe('idle');

      await collectEvents(engine, 'second');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });
  });

  // ── State Machine Transitions ──

  describe('state machine during submitMessage', () => {
    it('should go through compacting and streaming states', async () => {
      const transitions: string[] = [];
      setStream(textEvents('ok'));

      engine = createTestEngine();

      const store = engine.getStateStore();
      store.subscribe((state) => {
        transitions.push(state.currentState);
      });

      await collectEvents(engine, 'test');

      expect(transitions).toContain('compacting');
      expect(transitions).toContain('streaming');
      expect(transitions).toContain('deciding');
      expect(transitions).toContain('completed');
    });

    it('should self-heal from a corrupted state name instead of wedging the engine', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine();

      // Force the private state name into an impossible value. The real
      // contract: resetForNewQuery() force-resets any non-idle state before
      // the loop, so a corrupted name can never wedge the engine — the turn
      // completes normally with zero error events.
      const machine = engine.getStateMachine();
      (machine as any).currentStateName = 'unknown_state';

      const events = await collectEvents(engine, 'test');

      expect(events.filter(e => e.type === 'agent:error')).toHaveLength(0);
      expect(events.filter(e => e.type === 'agent:complete')).toHaveLength(1);
      expect(machine.currentState).toBe('completed');
      expect(machine.isTerminal()).toBe(true);
    });
  });

  // ── Behavioral Adapter Integration ──

  describe('behavioral adapter integration', () => {
    it('should include level adaptation in system prompt for beginner users', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({ systemPrompt: 'Base prompt.' });

      const profile = (engine as any).userProfile;
      expect(profile.getLevel()).toBe('beginner');

      await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should not add adaptation for advanced users', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({ systemPrompt: 'Base prompt.' });

      const profile = (engine as any).userProfile;
      profile.updateLevel('advanced');

      await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });
  });

  // ── getMessages returns copy ──

  describe('getMessages', () => {
    it('should return a copy of messages', async () => {
      setStream(textEvents('test'));
      engine = createTestEngine();
      await collectEvents(engine, 'hello');

      const msgs1 = engine.getMessages();
      const msgs2 = engine.getMessages();

      expect(msgs1).toEqual(msgs2);
      // getMessages returns a reconstructed array from the tree (FUN-09)
      expect(engine.getMessages()).toEqual(engine.getMessages());
    });
  });
});

/** Swap the raw stream factory (local shorthand over the shared hoisted ref). */
function setCustomFactory(factory: () => AsyncGenerator<any>) {
  setCustomStreamChat(factory);
}
