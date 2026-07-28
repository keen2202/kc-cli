// QueryEngine → post-turn hook dispatch tests (harness-evolution T8 wiring).
//
// The query completion point in the 'deciding' phase must fire the global
// post-turn hook registry (fire-and-forget) so plugin postTurn hooks and the
// T8 failure-signature → memory bridging hook actually run in production.
// These tests pin: dispatch happens exactly once per completed query with
// querySource 'query-engine', the registered failure-bridging hook fires off
// this path, and hook errors never affect query completion.

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

vi.mock('../../src/api', () => ({
  createAPIClient: vi.fn(() => ({
    streamChat: vi.fn(async function* () { yield* mockStreamChatRef.factory(); }),
    chat: mockChatImpl,
  })),
  BaseApiClient: class {},
  ApiError: class ApiError extends Error {},
}));

// The QueryEngine constructor builds a ToolExecutor, which instantiates a
// SandboxManager. Mock the sandbox layer so tests never require a real backend.
vi.mock('../../src/services/sandbox', () => {
  class MockSandboxManager {
    isAvailable = vi.fn(() => false);
    wrapCommand = vi.fn((cmd: string) => cmd);
    getBackendName = vi.fn(() => 'noop');
    shouldSandboxTool = vi.fn(() => 'run-unsandboxed');
  }
  return { SandboxManager: MockSandboxManager };
});

import { initializeState } from '../../src/bootstrap/state';
import type { LLMProvider } from '../../src/api';
import type { LLMStreamEvent } from '../../src/api/BaseApiClient';
import { QueryEngine } from '../../src/query/QueryEngine';
import {
  registerPostTurnHook,
  registerFailureBridgingHook,
  clearHooks,
  type PostTurnHookContext,
} from '../../src/hooks/postTurnHooks';
import { MemoryIntegration } from '../../src/memory/integration';
import type { EvidenceBundle } from '../../src/agp/sepl/protocol';

function setStream(events: LLMStreamEvent[]) {
  mockStreamChatRef.factory = async function* () { for (const event of events) { yield event; } };
}

function createEngine() {
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
    } as any,
    []
  );
}

async function runQuery(engine: QueryEngine, message = '你好') {
  const events: any[] = [];
  for await (const event of engine.submitMessage(message)) { events.push(event); }
  return events;
}

/** Wait for fire-and-forget hook promises to settle. */
function drainHooks() {
  return new Promise((r) => setTimeout(r, 50));
}

function makeBundle(count: number): EvidenceBundle {
  return {
    clusters: [
      {
        signature: { terminalCause: 'tool_timeout', causalStatus: 'direct', mechanism: 'retry_loop' },
        count,
        representativeEvents: [
          { id: 'e1', source: 'Shell', message: 'command timed out', timestamp: 1 },
        ],
        sharedSymptoms: ['timed out after 30s'],
      },
    ],
    totalFailures: count,
    generatedAt: Date.now(),
  };
}

beforeEach(() => {
  initializeState({ cwd: '/tmp', permissionMode: 'bypassPermissions' as any });
  vi.clearAllMocks();
  clearHooks();
  setStream([{ type: 'text_delta', text: '你好！' }, { type: 'stop' }]);
});

afterEach(() => {
  clearHooks();
});

describe('QueryEngine — post-turn hook dispatch', () => {
  it('fires registered post-turn hooks once when a query completes', async () => {
    const hook = vi.fn().mockResolvedValue(undefined);
    registerPostTurnHook(hook);

    const engine = createEngine();
    await runQuery(engine);
    await drainHooks();

    expect(engine.getStateMachine().currentState).toBe('completed');
    expect(hook).toHaveBeenCalledTimes(1);
    const context = hook.mock.calls[0][0] as PostTurnHookContext;
    expect(context.querySource).toBe('query-engine');
    expect(context.systemPrompt).toBe('You are helpful.');
    expect(context.messages.length).toBeGreaterThan(0);
  });

  it('runs the T8 failure-bridging hook off the completion path', async () => {
    const bridged: unknown[] = [];
    const integration = new MemoryIntegration({
      config: { enabled: true, failureBridging: true },
      getMemoryManifest: async () => [],
      getMemoryContent: async () => null,
      saveMemory: async (entry) => { bridged.push(entry); },
    });
    registerFailureBridgingHook(integration, () => makeBundle(3), { threshold: 1 });

    const engine = createEngine();
    await runQuery(engine);
    await drainHooks();

    // Bridging ran through the real integration and persisted a memory.
    expect(bridged).toHaveLength(1);
  });

  it('a throwing hook never affects query completion', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPostTurnHook(vi.fn().mockRejectedValue(new Error('hook boom')));

    const engine = createEngine();
    const events = await runQuery(engine);
    await drainHooks();

    expect(engine.getStateMachine().currentState).toBe('completed');
    expect(events.some((e) => e.type === 'agent:complete' || e.type === 'complete')).toBe(true);
    consoleSpy.mockRestore();
  });
});
