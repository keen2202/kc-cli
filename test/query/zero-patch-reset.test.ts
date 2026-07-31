// Zero-patch retry budget reset + failOnZeroPatch gating.
//
// Problem fixed: zeroPatchRetries/verificationRetries/typeCheckRetries were
// engine-instance fields that resetForNewQuery() never cleared, so a few
// task-classified Q&A queries (modifying no files) accumulated retries across
// queries and poisoned the session with a non-recoverable model_no_patch
// error after 2-4 conversation turns. Additionally, the hard failure is now
// opt-in via patchGuarantee.failOnZeroPatch (SWE-bench strict mode); default
// interactive sessions complete normally with the model's text answer.

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

vi.mock('../../src/services/compaction/functional', () => ({
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
import { KCError } from '../../src/utils/errors';

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

function noPatchErrors(events: any[]): any[] {
  return events.filter(
    (e) => e.type === 'agent:error' && e.error instanceof KCError && e.error.code === 'model_no_patch'
  );
}

/** Engine with patch guarantee ON; task-style queries hit the zero-patch gate. */
function createEngine(patchGuarantee: Record<string, any> = {}) {
  return new QueryEngine(
    {
      model: 'test-model',
      provider: 'openai' as LLMProvider,
      apiKey: 'test-key',
      maxTurns: 80,
      minTurns: 0,
      maxBudgetUsd: null,
      systemPrompt: 'You are helpful.',
      planningPhase: { enabled: false },
      patchGuarantee: {
        enabled: true,
        maxZeroPatchRetries: 1,
        typeCheck: false,
        ...patchGuarantee,
      },
    } as any,
    []
  );
}

const TASK_MESSAGE = 'fix the bug in the parser module please';

describe('QueryEngine — zero-patch retry budget per query', () => {
  beforeEach(() => {
    initializeState({ cwd: '/tmp', permissionMode: 'bypassPermissions' as any });
    vi.clearAllMocks();
    resetCreateAPIClientMock();
    setStream([{ type: 'text_delta', text: 'I inspected the code but changed nothing.' }, { type: 'stop' }]);
  });

  it('resets the zero-patch retry budget for each new user query', async () => {
    const engine = createEngine();

    // Query 1: 1 initial call + 1 PATCH REQUIRED retry (maxZeroPatchRetries: 1).
    await collectEvents(engine, TASK_MESSAGE);
    const callsAfterFirst = streamChatCalls;
    expect(callsAfterFirst).toBe(2);

    // Query 2: same fresh budget — retries must not accumulate across queries.
    // Before the fix the exhausted counter carried over and the second query
    // got zero retries (and eventually a model_no_patch error).
    const events2 = await collectEvents(engine, TASK_MESSAGE);
    expect(streamChatCalls - callsAfterFirst).toBe(2);
    expect(engine.getStateMachine().currentState).toBe('completed');
    expect(noPatchErrors(events2)).toHaveLength(0);
  });

  it('completes normally after retry exhaustion by default (no model_no_patch error)', async () => {
    const engine = createEngine();
    const events = await collectEvents(engine, TASK_MESSAGE);

    expect(engine.getStateMachine().currentState).toBe('completed');
    expect(noPatchErrors(events)).toHaveLength(0);
  });

  it('emits the non-recoverable model_no_patch error when failOnZeroPatch is true', async () => {
    const engine = createEngine({ failOnZeroPatch: true });
    const events = await collectEvents(engine, TASK_MESSAGE);

    const errors = noPatchErrors(events);
    expect(errors).toHaveLength(1);
    expect(errors[0].recoverable).toBe(false);
  });
});
