// QueryEngine Comprehensive Coverage Tests - Part 3
// Covers: streaming phase (basic), deciding phase

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

vi.mock('../../src/api', () => ({
  createAPIClient: vi.fn(() => ({
    streamChat: vi.fn(async function* () { yield* mockStreamChatRef.factory(); }),
    chat: mockChatImpl,
  })),
  BaseApiClient: class {},
  ApiError: class ApiError extends Error {
    statusCode?: number;
    responseHeaders?: Record<string, string>;
    constructor(msg: string, code?: number, headers?: Record<string, string>) {
      super(msg); this.statusCode = code; this.responseHeaders = headers;
    }
  },
}));

vi.mock('../../src/services/compaction', () => ({
  shouldCompact: vi.fn(() => false),
  microcompact: vi.fn((msgs: any) => ({ wasCompacted: false, messages: msgs, tokensSaved: 0 })),
  fullCompact: vi.fn(async (msgs: any) => ({ wasCompacted: false, messages: msgs, tokensSaved: 0 })),
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: 3,
}));

vi.mock('../../src/utils/tokenEstimation', () => ({
  estimateMessageTokensArray: vi.fn(() => mockTokenEstimateRef.value),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn(() => mockTokenEstimateRef.value),
}));

vi.mock('../../src/permissions/engine', () => ({
  hasPermissionsToUseTool: vi.fn(async () => ({ behavior: 'allow', message: 'auto-allowed' })),
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
  mergeSandboxPolicy: vi.fn((p: any) => p), DEFAULT_SANDBOX_POLICY: {},
  getToolPolicy: vi.fn(() => null), shouldSandbox: vi.fn(() => 'run-unsandboxed'),
}));

vi.mock('../../src/services/sandbox-profiles', () => ({
  BubblewrapSandbox: vi.fn().mockImplementation(() => ({ name: 'bubblewrap', isAvailable: vi.fn(() => false), wrapCommand: vi.fn((c: string) => c) })),
  SeccompSandbox: vi.fn().mockImplementation(() => ({ name: 'seccomp', isAvailable: vi.fn(() => false), wrapCommand: vi.fn((c: string) => c) })),
  NoopSandbox: vi.fn().mockImplementation(() => ({ name: 'noop', isAvailable: vi.fn(() => false), wrapCommand: vi.fn((c: string) => c) })),
}));

vi.mock('../../src/services/sandbox-probe', () => ({
  SandboxProbe: vi.fn().mockImplementation(() => ({ runProbe: vi.fn(async () => ({ passed: true, issues: [] })) })),
}));

vi.mock('../../src/services/sandbox-monitor', () => ({
  SandboxMonitor: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn(), getMetrics: vi.fn(() => ({})) })),
}));

vi.mock('../../src/services/sandbox-images', () => ({
  ImageManager: vi.fn().mockImplementation(() => ({ getBaseImage: vi.fn(() => null) })),
}));

import { initializeState } from '../../src/bootstrap/state';
import type { LLMProvider } from '../../src/api';
import type { ToolCall } from '../../src/types/message';
import type { LLMStreamEvent } from '../../src/api/BaseApiClient';
import { QueryEngine } from '../../src/query/QueryEngine';
import { createAPIClient } from '../../src/api';

function textEvents(text: string): LLMStreamEvent[] {
  return [{ type: 'text_delta', text }, { type: 'stop' }];
}

function toolEvents(text: string, toolCalls: ToolCall[]): LLMStreamEvent[] {
  const events: LLMStreamEvent[] = [{ type: 'text_delta', text }];
  for (const tc of toolCalls) { events.push({ type: 'tool_use', toolCall: tc }); }
  events.push({ type: 'stop' });
  return events;
}

function makeToolCall(toolName: string, input: Record<string, unknown> = {}): ToolCall {
  return { id: `tc_${toolName}_${Math.random().toString(36).slice(2, 8)}`, toolName, input, status: 'pending' };
}

function setStream(events: LLMStreamEvent[]) {
  mockStreamChatRef.factory = async function* () { for (const event of events) { yield event; } };
}

function textStream(text: string): AsyncGenerator<LLMStreamEvent> {
  return (async function* () { yield { type: 'text_delta', text }; yield { type: 'stop' }; })();
}

function toolStream(text: string, toolCalls: ToolCall[]): AsyncGenerator<LLMStreamEvent> {
  return (async function* () {
    yield { type: 'text_delta', text };
    for (const tc of toolCalls) { yield { type: 'tool_use', toolCall: tc }; }
    yield { type: 'stop' };
  })();
}

function setCustomStreamChat(factory: () => AsyncGenerator<LLMStreamEvent>) {
  (createAPIClient as ReturnType<typeof vi.fn>).mockReturnValue({
    streamChat: vi.fn(async function* () { yield* factory(); }),
    chat: mockChatImpl,
  });
}

async function collectEvents(engine: QueryEngine, message: string) {
  const events: any[] = [];
  for await (const event of engine.submitMessage(message)) { events.push(event); }
  return events;
}

describe('QueryEngine Coverage Part 3', () => {
  let engine: QueryEngine;

  function createEngine(overrides: Record<string, any> = {}) {
    return new QueryEngine(
      { model: 'test-model', provider: 'openai' as LLMProvider, apiKey: 'test-key', maxTurns: 10, maxBudgetUsd: null, systemPrompt: 'You are helpful.', ...overrides },
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

  describe('streaming phase', () => {
    it('should handle multiple text delta events', async () => {
      setStream([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'text_delta', text: '!' },
        { type: 'stop' },
      ]);

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const textDeltas = events.filter(e => e.type === 'agent:text_delta');
      expect(textDeltas).toHaveLength(3);
      expect(textDeltas[0].text).toBe('Hello ');
      expect(textDeltas[1].text).toBe('world');
      expect(textDeltas[2].text).toBe('!');
    });

    it('should handle error events during streaming', async () => {
      setStream([{ type: 'error', error: new Error('API error') }]);

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
    });

    it('should handle tool_use events during streaming', async () => {
      const tc = makeToolCall('FileRead', { path: '/tmp/test.txt' });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) { return toolStream('Reading file...', [tc]); }
        return textStream('Done reading.');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const toolStarted = events.filter(e => e.type === 'agent:tool_started');
      expect(toolStarted.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('deciding phase', () => {
    it('should decide no tools when assistant has no tool calls', async () => {
      setStream(textEvents('Just text, no tools.'));

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const completeEvents = events.filter(e => e.type === 'agent:complete');
      expect(completeEvents.length).toBe(1);
    });

    it('should decide tools when assistant has tool calls', async () => {
      const tc = makeToolCall('Bash', { command: 'echo hello' });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) { return toolStream('Running command...', [tc]); }
        return textStream('Done.');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const toolStarted = events.filter(e => e.type === 'agent:tool_started');
      expect(toolStarted.length).toBeGreaterThanOrEqual(1);
    });
  });
});
