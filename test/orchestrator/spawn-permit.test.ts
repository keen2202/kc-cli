// Orchestrator spawn-permit lifecycle — round4 §3-R4
//
// The semaphore bounds *how many* sub-agents run, but the release path was not
// idempotent: a terminal event followed by a failing `register()` returned two
// permits for one acquire, and a backend that never emitted a terminal event
// held its permit forever — permanently deadlocking the orchestrator.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let submitMessageImpl: () => AsyncGenerator<any> = async function* () {};

vi.mock('../../src/query/QueryEngine', () => ({
  QueryEngine: class MockQueryEngine {
    submitMessage(_msg: string) {
      return submitMessageImpl();
    }
    abort(_reason?: string) {}
    isAborted() { return false; }
  },
}));

function createParentContext(): any {
  return {
    cwd: '/test',
    abortController: new AbortController(),
    permissions: {
      mode: 'default',
      cwd: '/test',
      toolName: '',
      input: {},
      alwaysDenyRules: [],
      alwaysAskRules: [],
      alwaysAllowRules: [],
      bypassPermissions: false,
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  const state = await import('../../src/bootstrap/state');
  state.initializeState({ cwd: '/test', permissionMode: 'default' });
  process.env.KC_API_KEY = 'test-dummy-key';
  submitMessageImpl = async function* () {};
  vi.doMock('../../src/query/QueryEngine', () => ({
    QueryEngine: class MockQueryEngine {
      submitMessage(_msg: string) {
        return submitMessageImpl();
      }
      abort(_reason?: string) {}
      isAborted() { return false; }
    },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('spawn permit release', () => {
  it('releases the permit when the backend fails to spawn', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([], 2);
    const backend = (orchestrator as any).backend;
    vi.spyOn(backend, 'spawn').mockResolvedValue({ success: false, error: 'boom' });

    await expect(
      orchestrator.spawn({ name: 'a', prompt: 'p1', systemPromptMode: 'default' }, createParentContext()),
    ).rejects.toThrow(/Failed to spawn agent/);

    expect(orchestrator.availablePermits).toBe(2);
  });

  it('releases the permit when aggregator.register throws', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([], 2);
    vi.spyOn(orchestrator.getAggregator(), 'register').mockImplementation(() => {
      throw new Error('register exploded');
    });

    await expect(
      orchestrator.spawn({ name: 'a', prompt: 'p1', systemPromptMode: 'default' }, createParentContext()),
    ).rejects.toThrow('register exploded');

    expect(orchestrator.availablePermits).toBe(2);
  });

  it('releases at most once when terminal events repeat', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([], 2);
    const agentId = await orchestrator.spawn(
      { name: 'a', prompt: 'p1', systemPromptMode: 'default' },
      createParentContext(),
    );
    expect(orchestrator.availablePermits).toBe(1);

    const bus = orchestrator.getEventBus();
    // The same agent finishing several times (duplicate / replayed events) must
    // not hand back more than one permit — that is what inflated the count past
    // maxConcurrentAgents and let the bound be exceeded.
    bus.emit(agentId, { type: 'agent:subagent_completed', result: {} } as any);
    bus.emit(agentId, { type: 'agent:subagent_completed', result: {} } as any);
    bus.emit(agentId, { type: 'agent:subagent_failed', error: 'x' } as any);
    bus.emit(agentId, { type: 'agent:subagent_timed_out', elapsed: 1 } as any);

    expect(orchestrator.availablePermits).toBe(2);
    expect(orchestrator.availablePermits).toBeLessThanOrEqual(2);
  });

  it('does not double-release when a terminal event races a failing register', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([], 2);
    let capturedId = '';
    vi.spyOn(orchestrator.getAggregator(), 'register').mockImplementation((id: string) => {
      capturedId = id;
      throw new Error('late failure');
    });

    await expect(
      orchestrator.spawn({ name: 'a', prompt: 'p1', systemPromptMode: 'default' }, createParentContext()),
    ).rejects.toThrow('late failure');

    // Terminal event arrives after the failure path already released.
    orchestrator.getEventBus().emit(capturedId, {
      type: 'agent:subagent_completed',
      result: {},
    } as any);

    expect(orchestrator.availablePermits).toBe(2);
  });

  it('times out a permit acquisition rather than waiting forever', async () => {
    vi.useFakeTimers();
    try {
      const { AgentOrchestrator, resetOrchestrator } = await import(
        '../../src/orchestrator/agent-orchestrator'
      );
      resetOrchestrator();

      const orchestrator = new AgentOrchestrator([], 1);
      // Occupy the only permit and never emit a terminal event.
      await orchestrator.spawn(
        { name: 'squatter', prompt: 'p0', systemPromptMode: 'default' },
        createParentContext(),
      );

      const pending = orchestrator.spawn(
        { name: 'blocked', prompt: 'p1', systemPromptMode: 'default' },
        createParentContext(),
      );
      const verdict = expect(pending).rejects.toThrow(/Semaphore acquire timeout/);

      await vi.advanceTimersByTimeAsync(30_001);
      await verdict;
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the permit when waitForCompletion times out on a silent agent', async () => {
    vi.useFakeTimers();
    try {
      const { AgentOrchestrator, resetOrchestrator } = await import(
        '../../src/orchestrator/agent-orchestrator'
      );
      resetOrchestrator();

      const orchestrator = new AgentOrchestrator([], 2);
      const agentId = await orchestrator.spawn(
        { name: 'quiet', prompt: 'p1', systemPromptMode: 'default' },
        createParentContext(),
      );
      expect(orchestrator.availablePermits).toBe(1);

      const waiting = orchestrator.waitForCompletion(agentId, 1000);
      const verdict = expect(waiting).rejects.toThrow(/timed out/);

      await vi.advanceTimersByTimeAsync(1001);
      await verdict;

      // The agent never emitted a terminal event, so the wait-timeout hook is
      // the only thing that can give the permit back.
      expect(orchestrator.availablePermits).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
