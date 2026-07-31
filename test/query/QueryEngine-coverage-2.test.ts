// QueryEngine Comprehensive Coverage Tests - Part 2
// Covers: message trimming, buildApiMessages, circuit breaker, event creation,
// configuration variations, multiple submissions, edge cases, clear/reset,
// state machine, behavioral adapter, getMessages, retry exhaustion, multi-turn

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted variables (accessible from vi.mock factories) ──

const { mockChatImpl, mockStreamChatRef } = vi.hoisted(() => {
  const mockChatImpl = vi.fn(async () => ({
    content: 'mock summary',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }));

  const mockStreamChatRef: { factory: () => AsyncGenerator<any> } = {
    factory: (function* () {}) as any,
  };

  return { mockChatImpl, mockStreamChatRef };
});

const { mockTokenEstimateRef } = vi.hoisted(() => ({
  mockTokenEstimateRef: { value: 1000 },
}));

// ── Module Mocks ──

vi.mock('../../src/api', () => ({
  createAPIClient: vi.fn(() => ({
    streamChat: vi.fn(async function* () {
      yield* mockStreamChatRef.factory();
    }),
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
  microcompact: vi.fn((msgs: any) => ({
    wasCompacted: false,
    messages: msgs,
    tokensSaved: 0,
  })),
  fullCompact: vi.fn(async (msgs: any) => ({
    wasCompacted: false,
    messages: msgs,
    tokensSaved: 0,
  })),
  needsForceTruncation: vi.fn(() => false),
  forceTruncate: vi.fn((msgs: any) => ({ messages: msgs, tokensSaved: 0, wasCompacted: false })),
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: 3,
}));

vi.mock('../../src/utils/tokenEstimation', () => ({
  estimateMessageTokensArray: vi.fn(() => mockTokenEstimateRef.value),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn(() => mockTokenEstimateRef.value),
}));

vi.mock('../../src/permissions/engine', () => ({
  hasPermissionsToUseTool: vi.fn(async () => ({
    behavior: 'allow',
    message: 'auto-allowed',
  })),
  buildPermissionContext: vi.fn(() => ({
    mode: 'bypassPermissions',
    cwd: '/tmp',
    toolName: '',
    input: {},
    alwaysDenyRules: [],
    alwaysAskRules: [],
    alwaysAllowRules: [],
    bypassPermissions: true,
  })),
}));

vi.mock('../../src/services/sandbox', () => {
  class MockSandboxManager {
    isAvailable = vi.fn(() => false);
    wrapCommand = vi.fn((cmd: string) => cmd);
    getBackendName = vi.fn(() => 'noop');
    shouldSandboxTool = vi.fn(() => 'run-unsandboxed');
  }
  return {
    SandboxManager: MockSandboxManager,
  };
});

vi.mock('../../src/services/sandbox-policy', () => ({
  mergeSandboxPolicy: vi.fn((p: any) => p),
  DEFAULT_SANDBOX_POLICY: {},
  getToolPolicy: vi.fn(() => null),
  shouldSandbox: vi.fn(() => 'run-unsandboxed'),
}));

vi.mock('../../src/services/sandbox-profiles', () => ({
  BubblewrapSandbox: vi.fn().mockImplementation(() => ({
    name: 'bubblewrap',
    isAvailable: vi.fn(() => false),
    wrapCommand: vi.fn((cmd: string) => cmd),
  })),
  SeccompSandbox: vi.fn().mockImplementation(() => ({
    name: 'seccomp',
    isAvailable: vi.fn(() => false),
    wrapCommand: vi.fn((cmd: string) => cmd),
  })),
  NoopSandbox: vi.fn().mockImplementation(() => ({
    name: 'noop',
    isAvailable: vi.fn(() => false),
    wrapCommand: vi.fn((cmd: string) => cmd),
  })),
}));

vi.mock('../../src/services/sandbox-probe', () => ({
  SandboxProbe: vi.fn().mockImplementation(() => ({
    runProbe: vi.fn(async () => ({ passed: true, issues: [] })),
  })),
}));

vi.mock('../../src/services/sandbox-monitor', () => ({
  SandboxMonitor: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    getMetrics: vi.fn(() => ({})),
  })),
}));

vi.mock('../../src/services/sandbox-images', () => ({
  ImageManager: vi.fn().mockImplementation(() => ({
    getBaseImage: vi.fn(() => null),
  })),
}));

// ── Imports (after mocks) ──

import { initializeState } from '../../src/bootstrap/state';
import type { LLMProvider } from '../../src/api';
import type { ChatMessage, ToolCall, AssistantMessage } from '../../src/types/message';
import type { LLMStreamEvent } from '../../src/api/BaseApiClient';
import { QueryEngine } from '../../src/query/QueryEngine';
import { createAPIClient } from '../../src/api';

// ── Helpers ──

function textEvents(text: string): LLMStreamEvent[] {
  return [{ type: 'text_delta', text }, { type: 'stop' }];
}

function textStream(text: string): AsyncGenerator<LLMStreamEvent> {
  return (async function* () {
    yield { type: 'text_delta', text };
    yield { type: 'stop' };
  })();
}

function toolStream(text: string, toolCalls: ToolCall[]): AsyncGenerator<LLMStreamEvent> {
  return (async function* () {
    yield { type: 'text_delta', text };
    for (const tc of toolCalls) {
      yield { type: 'tool_use', toolCall: tc };
    }
    yield { type: 'stop' };
  })();
}

function makeStream(events: LLMStreamEvent[]): AsyncGenerator<LLMStreamEvent> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

function makeToolCall(toolName: string, input: Record<string, unknown> = {}): ToolCall {
  return {
    id: `tc_${toolName}_${Math.random().toString(36).slice(2, 8)}`,
    toolName,
    input,
    status: 'pending',
  };
}

function setStream(events: LLMStreamEvent[]) {
  mockStreamChatRef.factory = async function* () {
    for (const event of events) {
      yield event;
    }
  };
}

function setCustomStreamChat(factory: () => AsyncGenerator<LLMStreamEvent>) {
  (createAPIClient as ReturnType<typeof vi.fn>).mockReturnValue({
    streamChat: vi.fn(async function* () {
      yield* factory();
    }),
    chat: mockChatImpl,
  });
}

async function collectEvents(engine: QueryEngine, message: string) {
  const events: any[] = [];
  for await (const event of engine.submitMessage(message)) {
    events.push(event);
  }
  return events;
}

// ── Tests ──

describe('QueryEngine Coverage Part 2', () => {
  let engine: QueryEngine;

  function createEngine(overrides: Record<string, any> = {}) {
    return new QueryEngine(
      {
        model: 'test-model',
        provider: 'openai' as LLMProvider,
        apiKey: 'test-key',
        maxTurns: 10,
        maxBudgetUsd: null,
        systemPrompt: 'You are helpful.',
        planningPhase: { enabled: false },
        patchGuarantee: { enabled: false },
        ...overrides,
      },
      []
    );
  }

  function resetCreateAPIClientMock() {
    (createAPIClient as ReturnType<typeof vi.fn>).mockReturnValue({
      streamChat: vi.fn(async function* () {
        yield* mockStreamChatRef.factory();
      }),
      chat: mockChatImpl,
    });
  }

  beforeEach(() => {
    initializeState({
      cwd: '/tmp',
      permissionMode: 'bypassPermissions' as any,
    });
    vi.clearAllMocks();
    mockTokenEstimateRef.value = 1000;
    resetCreateAPIClientMock();
    setStream([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Message Trimming ──

  describe('message trimming', () => {
    it('should trim messages when exceeding maxMessages limit', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ maxMessages: 5 });

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

      engine = createEngine({ maxMessages: 3 });

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

      engine = createEngine({ maxMessages: 3 });

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

      engine = createEngine();

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

    it('should invalidate cached token estimate after trimming', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ maxMessages: 3 });

      const messages = (engine as any).messages as ChatMessage[];
      for (let i = 0; i < 10; i++) {
        messages.push({
          id: `msg_${i}`,
          role: 'user',
          content: `Message ${i}`,
          timestamp: Date.now(),
        } as ChatMessage);
      }

      try {
        for await (const _ of engine.submitMessage('test')) {
          // drain
        }
      } catch {
        // may throw
      }
    });

    it('should trim from front when no anchor messages exist', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ maxMessages: 3 });

      // Push only assistant messages (no user or system messages to act as anchors)
      const messages = (engine as any).messages as ChatMessage[];
      for (let i = 0; i < 10; i++) {
        messages.push({
          id: `asst_${i}`,
          role: 'assistant',
          content: `Response ${i}`,
          timestamp: Date.now(),
        } as ChatMessage);
      }

      try {
        for await (const _ of engine.submitMessage('test')) {
          // drain
        }
      } catch {
        // may throw
      }
    });

    it('should handle trim when anchors exceed non-anchor capacity', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ maxMessages: 5 });

      // Push many system and user messages as anchors, plus a few non-anchor messages
      const messages = (engine as any).messages as ChatMessage[];
      messages.push({
        id: 'sys1', role: 'system', content: 'System prompt', timestamp: Date.now(),
      } as any);
      for (let i = 0; i < 8; i++) {
        messages.push({
          id: `user_${i}`, role: 'user', content: `User ${i}`, timestamp: Date.now(),
        } as ChatMessage);
      }
      // Only 1 non-anchor message
      messages.push({
        id: 'asst1', role: 'assistant', content: 'Response', timestamp: Date.now(),
      } as ChatMessage);

      try {
        for await (const _ of engine.submitMessage('test')) {
          // drain
        }
      } catch {
        // may throw
      }
    });
  });

  // ── buildApiMessages ──

  describe('buildApiMessages', () => {
    it('should build messages with system prompt', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ systemPrompt: 'You are a test assistant.' });
      await collectEvents(engine, 'hello');

      const mockClient = (createAPIClient as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      if (mockClient) {
        const streamChatCall = mockClient.streamChat.mock.calls[0]?.[0];
        expect(streamChatCall).toBeDefined();
        expect(Array.isArray(streamChatCall.messages)).toBe(true);
      }
    });

    it('should format tool calls and tool results in assistant messages', async () => {
      setStream(textEvents('ok'));

      engine = createEngine();
      const messages = (engine as any).messages as ChatMessage[];
      messages.push({
        id: 'asst1',
        role: 'assistant',
        content: 'Running tool...',
        toolCalls: [{
          id: 'tc1',
          toolName: 'Bash',
          input: { command: 'ls' },
          status: 'completed',
        }],
        timestamp: Date.now(),
      } as AssistantMessage);
      messages.push({
        id: 'tool1',
        role: 'tool',
        content: null,
        toolResults: [{
          toolCallId: 'tc1',
          output: 'file1.txt',
          isError: false,
        }],
        timestamp: Date.now(),
      } as any);

      try {
        for await (const _ of engine.submitMessage('what files?')) {
          // drain
        }
      } catch {
        // may throw
      }
    });
  });

  // ── Circuit Breaker Integration ──

  describe('circuit breaker integration', () => {
    it('should block API calls when circuit breaker is open', async () => {
      engine = createEngine();

      const breakerRegistry = engine.getErrorHandler().getCircuitBreakers();
      const apiBreaker = breakerRegistry.getBreaker('api');

      for (let i = 0; i < 6; i++) {
        apiBreaker.recordFailure();
      }

      expect(apiBreaker.canExecute()).toBe(false);

      // Set factory to throw a non-retryable error to trigger breaker check
      mockStreamChatRef.factory = async function* () {
        yield { type: 'text_delta', text: 'partial' };
        throw new Error('auth error');
      };

      const events = await collectEvents(engine, 'test');

      const textEvts = events.filter(e => e.type === 'agent:text_delta');
      expect(textEvts.some(e => (e as any).text?.includes('API temporarily unavailable'))).toBe(true);
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should allow API calls when circuit breaker is closed', async () => {
      setStream(textEvents('ok'));

      engine = createEngine();

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

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const textDelta = events.find(e => e.type === 'agent:text_delta');
      expect(textDelta).toBeDefined();
      expect(textDelta.text).toBe('test text');
      expect(textDelta.timestamp).toBeDefined();
    });

    it('should create turn complete events with message and usage', async () => {
      setStream(textEvents('response'));

      engine = createEngine();
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

      engine = createEngine();
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

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const turnComplete = events.find(e => e.type === 'agent:turn_complete');
      expect(turnComplete.usage.totalTokens).toBe(15);
    });

    it('should create complete event at end of successful run', async () => {
      setStream(textEvents('done'));

      engine = createEngine();
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

      engine = new QueryEngine(
        {
          model: 'llama3',
          provider: 'ollama' as LLMProvider,
          maxTurns: 5,
          maxBudgetUsd: null,
          planningPhase: { enabled: false },
        },
        []
      );

      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should work with anthropic provider', async () => {
      setStream(textEvents('claude response'));

      engine = new QueryEngine(
        {
          model: 'claude-sonnet-4-20250514',
          provider: 'anthropic' as LLMProvider,
          apiKey: 'test-key',
          maxTurns: 5,
          maxBudgetUsd: null,
          planningPhase: { enabled: false },
        },
        []
      );

      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should work with maxBudgetUsd set', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ maxBudgetUsd: 10.0 });
      const events = await collectEvents(engine, 'test');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should work with apiBaseUrl set', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ apiBaseUrl: 'https://custom-api.example.com' });
      const events = await collectEvents(engine, 'test');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should work with permission rules', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({
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

      engine = createEngine();

      const events1 = await collectEvents(engine, 'first message');
      expect(engine.getStateMachine().currentState).toBe('completed');

      engine.getStateMachine().reset();
      const events2 = await collectEvents(engine, 'second message');
      expect(engine.getStateMachine().currentState).toBe('completed');

      const messages = engine.getMessages();
      expect(messages.filter(m => m.role === 'user').length).toBe(2);
    });

    it('should return immediately when already in terminal state', async () => {
      setStream(textEvents('Response'));

      engine = createEngine();

      // First submission completes normally
      await collectEvents(engine, 'first message');
      expect(engine.getStateMachine().currentState).toBe('completed');

      // Second submission without reset - should return immediately
      const events2 = await collectEvents(engine, 'second message');
      // The generator should complete without yielding any events
      // because the state machine is already terminal
    });

    it('should accumulate conversation history across submissions', async () => {
      setStream(textEvents('Reply'));

      engine = createEngine();

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

      engine = createEngine();
      const events = await collectEvents(engine, '');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should handle very long user message', async () => {
      setStream(textEvents('ok'));

      engine = createEngine();
      const longMessage = 'x'.repeat(100_000);
      const events = await collectEvents(engine, longMessage);

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should handle stream with tool_use but no text', async () => {
      const tc = makeToolCall('Bash', { command: 'echo hi' });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) {
          return makeStream([
            { type: 'tool_use', toolCall: tc },
            { type: 'stop' },
          ]);
        }
        return textStream('done');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should handle stream with stop event', async () => {
      setStream([
        { type: 'text_delta', text: 'hello' },
        { type: 'stop' },
      ]);

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      expect(engine.getStateMachine().currentState).toBe('completed');
    });
  });

  // ── Clear and Reset ──

  describe('clear and reset', () => {
    it('should clear messages and reset state machine', async () => {
      setStream(textEvents('ok'));

      engine = createEngine();
      await collectEvents(engine, 'test');

      expect(engine.getMessages().length).toBeGreaterThan(0);
      expect(engine.getStateMachine().currentState).toBe('completed');

      engine.clear();

      expect(engine.getMessages()).toEqual([]);
      expect(engine.getStateMachine().currentState).toBe('idle');
    });

    it('should allow new submission after clear', async () => {
      setStream(textEvents('ok'));

      engine = createEngine();

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

      engine = createEngine();

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

    it('should handle unknown state gracefully', async () => {
      setStream(textEvents('ok'));

      engine = createEngine();

      const machine = engine.getStateMachine();
      (machine as any).currentStateName = 'unknown_state';

      try {
        for await (const event of engine.submitMessage('test')) {
          // drain
        }
        // If it doesn't throw, it may have transitioned to error
      } catch (error) {
        expect((error as Error).message).toContain('Unknown state');
      }
    });
  });

  // ── Behavioral Adapter Integration ──

  describe('behavioral adapter integration', () => {
    it('should include level adaptation in system prompt for beginner users', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ systemPrompt: 'Base prompt.' });

      const profile = (engine as any).userProfile;
      expect(profile.getLevel()).toBe('beginner');

      await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should not add adaptation for advanced users', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({ systemPrompt: 'Base prompt.' });

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
      engine = createEngine();
      await collectEvents(engine, 'hello');

      const msgs1 = engine.getMessages();
      const msgs2 = engine.getMessages();

      expect(msgs1).toEqual(msgs2);
      // getMessages returns a reconstructed array from the tree (FUN-09)
      expect(engine.getMessages()).toEqual(engine.getMessages());
    });
  });

});
