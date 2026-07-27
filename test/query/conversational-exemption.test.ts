// Conversational-query exemption tests.
//
// Greetings/small talk must complete with zero tool calls and must NOT be
// dragged through the SWE-bench task machinery (Phase 1/3 steers,
// anti-abandonment, zero-patch "PATCH REQUIRED" continuation). Task-style
// messages keep the original behavior.

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
  needsForceTruncation: vi.fn(() => false),
  forceTruncate: vi.fn((msgs: any) => ({ messages: msgs, tokensSaved: 0, wasCompacted: false })),
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: 3,
}));

vi.mock('../../src/utils/tokenEstimation', () => ({
  estimateMessageTokensArray: vi.fn(() => 1000),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn(() => 1000),
}));

vi.mock('../../src/permissions/engine', () => ({
  hasPermissionsToUseTool: vi.fn(async () => ({ behavior: 'allow', message: 'auto-allowed' })),
  buildPermissionContext: vi.fn(() => ({
    mode: 'bypassPermissions', cwd: '/tmp', toolName: '', input: {},
    alwaysDenyRules: [], alwaysAskRules: [], alwaysAllowRules: [], bypassPermissions: true,
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

let streamChatCalls = 0;

function setStream(events: LLMStreamEvent[]) {
  mockStreamChatRef.factory = async function* () { for (const event of events) { yield event; } };
}

function resetCreateAPIClientMock() {
  streamChatCalls = 0;
  (createAPIClient as ReturnType<typeof vi.fn>).mockReturnValue({
    streamChat: vi.fn(async function* () {
      streamChatCalls++;
      yield* mockStreamChatRef.factory();
    }),
    chat: mockChatImpl,
  });
}

async function collectEvents(engine: QueryEngine, message: string) {
  const events: any[] = [];
  for await (const event of engine.submitMessage(message)) { events.push(event); }
  return events;
}

/** Engine with the SWE task machinery ON (patch guarantee enabled, minTurns). */
function createTaskHardenedEngine(overrides: Record<string, any> = {}) {
  return new QueryEngine(
    {
      model: 'test-model',
      provider: 'openai' as LLMProvider,
      apiKey: 'test-key',
      maxTurns: 80,
      minTurns: 5,
      maxBudgetUsd: null,
      systemPrompt: 'You are helpful.',
      planningPhase: { enabled: false },
      patchGuarantee: {
        enabled: true,
        maxZeroPatchRetries: 1,
        typeCheck: false,
      },
      ...overrides,
    },
    []
  );
}

describe('QueryEngine — conversational-query exemption', () => {
  beforeEach(() => {
    initializeState({ cwd: '/tmp', permissionMode: 'bypassPermissions' as any });
    vi.clearAllMocks();
    resetCreateAPIClientMock();
    setStream([{ type: 'text_delta', text: '你好！有什么可以帮你？' }, { type: 'stop' }]);
  });

  it('completes a greeting in a single model turn with zero tool calls', async () => {
    const engine = createTaskHardenedEngine();
    const events = await collectEvents(engine, '你好');

    expect(engine.getStateMachine().currentState).toBe('completed');
    // No forced continuation: exactly one model call.
    expect(streamChatCalls).toBe(1);
    expect(events.filter((e) => e.type === 'agent:tool_started').length).toBe(0);
  });

  it('does not inject PATCH REQUIRED or phase steers for a greeting', async () => {
    const engine = createTaskHardenedEngine();
    await collectEvents(engine, '你好');

    const contents = engine.getMessages().map((m) => String(m.content ?? ''));
    expect(contents.some((c) => c.includes('PATCH REQUIRED'))).toBe(false);
    expect(contents.some((c) => c.includes('[Phase 1 - Planning]'))).toBe(false);
    expect(contents.some((c) => c.includes('[Anti-Abandonment]'))).toBe(false);
  });

  it('keeps zero-patch continuation for task-style messages', async () => {
    setStream([{ type: 'text_delta', text: 'I looked around but changed nothing.' }, { type: 'stop' }]);
    const engine = createTaskHardenedEngine({ minTurns: 0 });
    await collectEvents(engine, 'fix the bug in the parser');

    // Zero files modified on exit → one PATCH REQUIRED retry (maxZeroPatchRetries: 1).
    expect(streamChatCalls).toBeGreaterThan(1);
    const contents = engine.getMessages().map((m) => String(m.content ?? ''));
    expect(contents.some((c) => c.includes('PATCH REQUIRED'))).toBe(true);
  });
});
