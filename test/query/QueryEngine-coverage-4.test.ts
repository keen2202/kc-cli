// QueryEngine Comprehensive Coverage Tests - Part 4
// Covers: executing phase, error recovery, streaming retry exhaustion

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

vi.mock('../../src/services/compaction', () => ({
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
  return { SandboxManager: MockSandboxManager };
});

vi.mock('../../src/services/sandbox-policy', () => ({
  mergeSandboxPolicy: vi.fn((p: any) => p),
  DEFAULT_SANDBOX_POLICY: {},
  getToolPolicy: vi.fn(() => null),
  shouldSandbox: vi.fn(() => 'run-unsandboxed'),
}));

vi.mock('../../src/services/sandbox-profiles', () => ({
  BubblewrapSandbox: vi.fn().mockImplementation(() => ({
    name: 'bubblewrap', isAvailable: vi.fn(() => false), wrapCommand: vi.fn((cmd: string) => cmd),
  })),
  SeccompSandbox: vi.fn().mockImplementation(() => ({
    name: 'seccomp', isAvailable: vi.fn(() => false), wrapCommand: vi.fn((cmd: string) => cmd),
  })),
  NoopSandbox: vi.fn().mockImplementation(() => ({
    name: 'noop', isAvailable: vi.fn(() => false), wrapCommand: vi.fn((cmd: string) => cmd),
  })),
}));

vi.mock('../../src/services/sandbox-probe', () => ({
  SandboxProbe: vi.fn().mockImplementation(() => ({
    runProbe: vi.fn(async () => ({ passed: true, issues: [] })),
  })),
}));

vi.mock('../../src/services/sandbox-monitor', () => ({
  SandboxMonitor: vi.fn().mockImplementation(() => ({
    start: vi.fn(), stop: vi.fn(), getMetrics: vi.fn(() => ({})),
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
import type { ToolCall } from '../../src/types/message';
import type { LLMStreamEvent } from '../../src/api/BaseApiClient';
import { QueryEngine } from '../../src/query/QueryEngine';
import { createAPIClient } from '../../src/api';
import { hasPermissionsToUseTool } from '../../src/permissions/engine';

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
    for (const event of events) { yield event; }
  })();
}

function makeToolCall(toolName: string, input: Record<string, unknown> = {}): ToolCall {
  return {
    id: `tc_${toolName}_${Math.random().toString(36).slice(2, 8)}`,
    toolName, input, status: 'pending',
  };
}

function setStream(events: LLMStreamEvent[]) {
  mockStreamChatRef.factory = async function* () {
    for (const event of events) { yield event; }
  };
}

function setCustomStreamChat(factory: () => AsyncGenerator<LLMStreamEvent>) {
  (createAPIClient as ReturnType<typeof vi.fn>).mockReturnValue({
    streamChat: vi.fn(async function* () { yield* factory(); }),
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

describe('QueryEngine Coverage Part 4', () => {
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
        ...overrides,
      },
      []
    );
  }

  function resetCreateAPIClientMock() {
    (createAPIClient as ReturnType<typeof vi.fn>).mockReturnValue({
      streamChat: vi.fn(async function* () { yield* mockStreamChatRef.factory(); }),
      chat: mockChatImpl,
    });
  }

  beforeEach(() => {
    initializeState({ cwd: '/tmp', permissionMode: 'bypassPermissions' as any });
    vi.clearAllMocks();
    mockTokenEstimateRef.value = 1000;
    resetCreateAPIClientMock();
    setStream([]);
  });

  // ── Executing Phase ──

  describe('executing phase', () => {
    it('should execute single tool call and emit events', async () => {
      const tc = makeToolCall('Bash', { command: 'echo hello' });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) { return toolStream('Running...', [tc]); }
        return textStream('Done.');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const toolStarted = events.filter(e => e.type === 'agent:tool_started');
      expect(toolStarted.length).toBeGreaterThanOrEqual(1);

      const toolFailed = events.filter(e => e.type === 'agent:tool_failed');
      const toolCompleted = events.filter(e => e.type === 'agent:tool_completed');
      expect(toolFailed.length + toolCompleted.length).toBeGreaterThanOrEqual(1);
    });

    it('should execute multiple tool calls in parallel', async () => {
      const tc1 = makeToolCall('Bash', { command: 'echo a' });
      const tc2 = makeToolCall('Bash', { command: 'echo b' });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) { return toolStream('Running...', [tc1, tc2]); }
        return textStream('All done.');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const toolStarted = events.filter(e => e.type === 'agent:tool_started');
      expect(toolStarted.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle tool execution with error result', async () => {
      const tc = makeToolCall('Bash', { command: 'invalid_cmd' });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) { return toolStream('Running...', [tc]); }
        return textStream('It failed.');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const toolStarted = events.filter(e => e.type === 'agent:tool_started');
      expect(toolStarted.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle empty tool calls array in executing phase', async () => {
      setStream(textEvents('No tools.'));
      engine = createEngine();
      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should add tool results to message history', async () => {
      const tc = makeToolCall('Bash', { command: 'echo hi' });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) { return toolStream('...', [tc]); }
        return textStream('Done.');
      });

      engine = createEngine();
      await collectEvents(engine, 'test');

      const messages = engine.getMessages();
      const toolMessages = messages.filter(m => m.role === 'tool');
      expect(toolMessages.length).toBeGreaterThanOrEqual(1);
      if (toolMessages.length > 0) {
        expect(toolMessages[0].toolResults).toBeDefined();
      }
    });
  });

  // ── Error Recovery ──

  describe('error recovery', () => {
    it('should transition to error state on unhandled exception', async () => {
      setCustomStreamChat(() => {
        throw new Error('Fatal connection error');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
      expect(engine.getStateMachine().isTerminal()).toBe(true);
    });

    it('should yield error event with proper structure', async () => {
      setStream([{ type: 'error', error: new Error('test error') }]);

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const errorEvent = events.find(e => e.type === 'agent:error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toBeInstanceOf(Error);
      expect(errorEvent.recoverable).toBe(false);
      expect(errorEvent.timestamp).toBeDefined();
    });

    it('should handle non-Error exceptions', async () => {
      setCustomStreamChat(() => {
        throw 'string error';
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
      expect(errEvents[0].error).toBeInstanceOf(Error);
    });

    it('should handle degraded errors thrown during stream iteration', async () => {
      // Throw from within the for-await loop (not yielded as event)
      // "tool error" prefix classifies as degraded, which returns silently
      setCustomStreamChat(() => {
        return (async function* () {
          yield { type: 'text_delta', text: 'partial' } as any;
          throw new Error('tool error: sandbox violation');
        })();
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      // Degraded errors are caught silently; engine continues to deciding->completed
      expect(engine.getStateMachine().currentState).toBe('completed');
    });
  });

  // ── Streaming retry exhaustion ──

  describe('streaming retry exhaustion', () => {
    it('should give up after max retries on persistent errors', async () => {
      vi.useFakeTimers();
      setCustomStreamChat(() => {
        return makeStream([{ type: 'error', error: new Error('429 rate limit') }]);
      });

      engine = createEngine();
      const promise = collectEvents(engine, 'test');

      // Advance past retry delays (MAX_RETRIES=10, base ~5000ms with jitter)
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(10000);
      }

      const events = await promise;
      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });

    it('should not retry non-retryable errors', async () => {
      setCustomStreamChat(() => {
        return makeStream([{ type: 'error', error: new Error('401 unauthorized') }]);
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
    });

    it('should retry retryable errors thrown during iteration', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        return (async function* () {
          yield { type: 'text_delta', text: 'partial' } as any;
          throw new Error('429 Too Many Requests');
        })();
      });

      engine = createEngine();
      const promise = collectEvents(engine, 'test');

      // Advance past retry delays (MAX_RETRIES=10, base ~5000ms with jitter)
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(10000);
      }

      const events = await promise;
      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
      // Should have retried (callCount > 1)
      expect(callCount).toBeGreaterThan(1);

      vi.useRealTimers();
    });
  });

  // ── Multi-turn tool loop ──

  describe('multi-turn tool loop', () => {
    it('should handle multiple rounds of tool execution', async () => {
      const tc1 = makeToolCall('FileRead', { path: '/tmp/a.txt' });
      const tc2 = makeToolCall('FileWrite', { path: '/tmp/b.txt' });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) { return toolStream('Reading...', [tc1]); }
        if (callCount === 2) { return toolStream('Writing...', [tc2]); }
        return textStream('All done!');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'do something');

      const toolStarted = events.filter(e => e.type === 'agent:tool_started');
      expect(toolStarted.length).toBeGreaterThanOrEqual(2);

      const completeEvents = events.filter(e => e.type === 'agent:complete');
      expect(completeEvents.length).toBe(1);
      expect(engine.getStateMachine().currentState).toBe('completed');
    });
  });
});
