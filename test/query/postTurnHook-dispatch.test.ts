// QueryEngine → post-turn hook dispatch tests.
//
// The query completion point must fire the global post-turn hook registry
// (fire-and-forget) so plugin postTurn hooks actually run in production.
// AGP failure-bridging hook was removed in experiment-runtime T13.

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
  clearHooks,
  type PostTurnHookContext,
} from '../../src/hooks/postTurnHooks';

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
