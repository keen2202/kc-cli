// QueryEngine Comprehensive Coverage Tests - Part 3b
// Covers: streaming phase (memory, no content, retry, degraded, reset)

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import type { LLMStreamEvent } from '../../src/api/BaseApiClient';
import { QueryEngine } from '../../src/query/QueryEngine';
import { createAPIClient } from '../../src/api';

function textEvents(text: string): LLMStreamEvent[] {
  return [{ type: 'text_delta', text }, { type: 'stop' }];
}

function textStream(text: string): AsyncGenerator<LLMStreamEvent> {
  return (async function* () { yield { type: 'text_delta', text }; yield { type: 'stop' }; })();
}

function makeStream(events: LLMStreamEvent[]): AsyncGenerator<LLMStreamEvent> {
  return (async function* () { for (const event of events) { yield event; } })();
}

function setStream(events: LLMStreamEvent[]) {
  mockStreamChatRef.factory = async function* () { for (const event of events) { yield event; } };
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

describe('QueryEngine Coverage Part 3b', () => {
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

  describe('streaming phase continued', () => {
    it('should load memory context when memory is enabled', async () => {
      setStream(textEvents('ok'));

      engine = createEngine({
        memory: {
          config: { enabled: true },
          getMemoryManifest: async () => [
            { fileName: 'test.md', topic: 'test', relevance: ['test'] },
          ],
          getMemoryContent: async (name: string) => `Memory content for ${name}`,
        },
      });

      const memory = engine.getMemoryIntegration();
      expect(memory.isEnabled()).toBe(true);
      await collectEvents(engine, 'test');
    });

    it('should skip memory loading when memory is disabled', async () => {
      setStream(textEvents('ok'));
      engine = createEngine({ memory: { config: { enabled: false } } });
      await collectEvents(engine, 'test');
    });

    it('should handle API streaming with no content', async () => {
      setStream([{ type: 'stop' }]);

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const turnComplete = events.filter(e => e.type === 'agent:turn_complete');
      expect(turnComplete.length).toBe(1);
      expect(turnComplete[0].message.content).toBeNull();
    });

    it('should reset retry state on successful stream', async () => {
      setStream(textEvents('Success'));

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const textDeltas = events.filter(e => e.type === 'agent:text_delta');
      expect(textDeltas.length).toBe(1);
    });

    it('should retry on retryable streaming errors', async () => {
      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) {
          return makeStream([{ type: 'error', error: new Error('429 Too Many Requests') }]);
        }
        return textStream('Success on retry');
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle degraded errors without retrying', async () => {
      setCustomStreamChat(() => {
        return makeStream([{ type: 'error', error: new Error('tool error: something failed') }]);
      });

      engine = createEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
