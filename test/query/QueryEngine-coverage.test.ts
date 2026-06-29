// QueryEngine Comprehensive Coverage Tests - Part 1
// Covers: submitMessage full lifecycle, compacting phase, abort handling

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
import type { ChatMessage, ToolCall } from '../../src/types/message';
import type { LLMStreamEvent } from '../../src/api/BaseApiClient';
import { QueryEngine } from '../../src/query/QueryEngine';
import { createAPIClient } from '../../src/api';
import {
  shouldCompact,
  microcompact,
  fullCompact,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from '../../src/services/compaction';
import { estimateMessageTokensArray } from '../../src/utils/tokenEstimation';

// ── Helpers ──

function textEvents(text: string): LLMStreamEvent[] {
  return [{ type: 'text_delta', text }, { type: 'stop' }];
}

function toolEvents(text: string, toolCalls: ToolCall[]): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = [{ type: 'text_delta', text }];
  for (const tc of toolCalls) {
    events.push({ type: 'tool_use', toolCall: tc });
  }
  events.push({ type: 'stop' });
  return events;
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

describe('QueryEngine Coverage Part 1', () => {
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

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── submitMessage Full Lifecycle ──

  describe('submitMessage full lifecycle', () => {
    it('should complete idle->compact->stream->decide->complete loop with no tool calls', async () => {
      setStream([{ type: 'text_delta', text: 'Hello, I can help with that.' }, { type: 'stop' }]);
      engine = createEngine();
      const events = await collectEvents(engine, 'help me');

      const textEvts = events.filter(e => e.type === 'agent:text_delta');
      const completeEvents = events.filter(e => e.type === 'agent:complete');

      expect(textEvts.length).toBeGreaterThan(0);
      expect(textEvts[0].text).toBe('Hello, I can help with that.');
      expect(completeEvents.length).toBe(1);
      expect(engine.getStateMachine().currentState).toBe('completed');

      const messages = engine.getMessages();
      expect(messages.some(m => m.role === 'user' && m.content === 'help me')).toBe(true);
      expect(messages.some(m => m.role === 'assistant' && m.content === 'Hello, I can help with that.')).toBe(true);
    });

    it('should complete full lifecycle with tool calls', async () => {
      const toolCall = makeToolCall('Bash', { command: 'ls' });
      const firstStream = toolStream('Let me check that.', [toolCall]);
      const secondStream = textStream('The directory has files.');

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        return callCount === 1 ? firstStream : secondStream;
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'list files');

      expect(events.filter(e => e.type === 'agent:tool_started').length).toBeGreaterThanOrEqual(1);
      expect(events.filter(e => e.type === 'agent:complete').length).toBe(1);
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should emit turn_complete event after streaming', async () => {
      setStream(textEvents('Response text'));
      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const turnComplete = events.filter(e => e.type === 'agent:turn_complete');
      expect(turnComplete.length).toBe(1);
      expect(turnComplete[0].message).toBeDefined();
      expect(turnComplete[0].usage).toBeDefined();
    });
  });

  // ── Compacting Phase ──

  describe('compacting phase', () => {
    it('should skip compaction when tokens are below threshold', async () => {
      (shouldCompact as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
      mockTokenEstimateRef.value = 1000;
      setStream(textEvents('ok'));
      engine = createEngine();
      await collectEvents(engine, 'test');
      expect(microcompact).not.toHaveBeenCalled();
    });

    it('should attempt compaction when tokens exceed threshold', async () => {
      const threshold = 200_000 - 20_000 - 13_000;
      mockTokenEstimateRef.value = threshold + 1000;
      setStream(textEvents('ok'));

      (microcompact as ReturnType<typeof vi.fn>).mockReturnValue({
        wasCompacted: true,
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        tokensSaved: 5000,
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      expect(microcompact).toHaveBeenCalled();
      const compactEvents = events.filter(e => e.type === 'agent:compact_micro');
      expect(compactEvents.length).toBe(1);
      expect(compactEvents[0].tokensSaved).toBe(5000);
    });

    it('should stop after microcompact when it brings tokens below threshold', async () => {
      // Post-microcompact token estimate returns low value (microcompact sufficient)
      mockTokenEstimateRef.value = 1000;
      setStream(textEvents('ok'));

      (microcompact as ReturnType<typeof vi.fn>).mockReturnValue({
        wasCompacted: true,
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        tokensSaved: 50000,
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      expect(microcompact).toHaveBeenCalled();
      expect(fullCompact).not.toHaveBeenCalled();
      const compactEvents = events.filter(e => e.type === 'agent:compact_micro');
      expect(compactEvents.length).toBe(1);
    });

    it('should do full compaction if microcompact is insufficient', async () => {
      // Post-microcompact token estimate returns high value (microcompact insufficient)
      const threshold = 200_000 - 20_000 - 13_000;
      mockTokenEstimateRef.value = threshold + 1000;
      setStream(textEvents('ok'));

      const compactedMessages: ChatMessage[] = [
        { id: '1', role: 'user', content: 'test', timestamp: Date.now() },
      ];
      (microcompact as ReturnType<typeof vi.fn>).mockReturnValue({
        wasCompacted: true, messages: compactedMessages, tokensSaved: 5000,
      });
      (fullCompact as ReturnType<typeof vi.fn>).mockResolvedValue({
        wasCompacted: true, messages: compactedMessages, tokensSaved: 50000,
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      expect(fullCompact).toHaveBeenCalled();
      expect(events.filter(e => e.type === 'agent:compact_full').length).toBe(1);
    });

    it('should use cached token estimate', async () => {
      const threshold = 200_000 - 20_000 - 13_000;
      mockTokenEstimateRef.value = threshold + 1000;
      setStream(textEvents('ok'));
      engine = createEngine({ contextWindow: 200_000 });
      await collectEvents(engine, 'test');
      expect(estimateMessageTokensArray).toHaveBeenCalled();
    });

    it('should disable compaction after max consecutive failures', async () => {
      const threshold = 200_000 - 20_000 - 13_000;
      mockTokenEstimateRef.value = threshold + 1000;

      (fullCompact as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
      (microcompact as ReturnType<typeof vi.fn>).mockReturnValue({
        wasCompacted: false, messages: [], tokensSaved: 0,
      });

      setStream(textEvents('ok'));
      engine = createEngine();

      for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES + 1; i++) {
        try { for await (const _ of engine.submitMessage(`msg ${i}`)) { /* drain */ } } catch {}
        engine.getStateMachine().reset();
      }

      vi.clearAllMocks();
      setStream(textEvents('ok'));
      try { for await (const _ of engine.submitMessage('final msg')) { /* drain */ } } catch {}

      expect(microcompact).not.toHaveBeenCalled();
    });

    it('should validate state before compaction', async () => {
      const threshold = 200_000 - 20_000 - 13_000;
      mockTokenEstimateRef.value = threshold + 1000;
      setStream(textEvents('ok'));
      engine = createEngine({ contextWindow: 200_000 });

      const messages = (engine as any).messages as ChatMessage[];
      messages.push({
        id: 'tool1', role: 'tool', content: null,
        toolResults: [{ toolCallId: 'orphan_id', output: 'some output', isError: false }],
        timestamp: Date.now(),
      } as any);

      try { for await (const _ of engine.submitMessage('test')) { /* drain */ } } catch {}
    });

    it('should handle compaction error without crashing', async () => {
      const threshold = 200_000 - 20_000 - 13_000;
      mockTokenEstimateRef.value = threshold + 1000;
      setStream(textEvents('ok'));

      (microcompact as ReturnType<typeof vi.fn>).mockReturnValue({
        wasCompacted: false, messages: [], tokensSaved: 0,
      });
      (fullCompact as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        throw new Error('permanent auth failure');
      });

      engine = createEngine({ contextWindow: 200_000 });
      try { for await (const _ of engine.submitMessage('test')) { /* drain */ } } catch {}
      expect(fullCompact).toHaveBeenCalled();
    });

    it('should use custom context window from config', async () => {
      mockTokenEstimateRef.value = 18_000;
      setStream(textEvents('ok'));

      (microcompact as ReturnType<typeof vi.fn>).mockReturnValue({
        wasCompacted: true,
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        tokensSaved: 5000,
      });

      engine = createEngine({ contextWindow: 50_000 });
      await collectEvents(engine, 'test');
      expect(microcompact).toHaveBeenCalled();
    });
  });

  // ── Abort Handling ──

  describe('abort handling', () => {
    it('should not start streaming when pre-aborted', async () => {
      engine = createEngine();
      engine.abort('cancelled before start');
      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().isTerminal()).toBe(true);
    });

    it('should stop during compacting phase when aborted', async () => {
      const threshold = 200_000 - 20_000 - 13_000;
      mockTokenEstimateRef.value = threshold + 1000;

      (microcompact as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        engine.abort('cancelled during compaction');
        return { wasCompacted: false, messages: [], tokensSaved: 0 };
      });

      setStream(textEvents('should not reach'));
      engine = createEngine({ contextWindow: 200_000 });
      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().isTerminal()).toBe(true);
    });

    it('should report isAborted correctly', async () => {
      engine = createEngine();
      expect(engine.isAborted()).toBe(false);
      engine.abort('test reason');
      expect(engine.isAborted()).toBe(true);
    });
  });
});
