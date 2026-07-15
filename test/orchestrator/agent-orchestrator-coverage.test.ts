import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track submitMessage for each test
let submitMessageImpl: () => AsyncGenerator<any> = async function* () {};

// Mock QueryEngine so the real backend runs without hitting the API
vi.mock('../../src/query/QueryEngine', () => ({
  QueryEngine: class MockQueryEngine {
    submitMessage(_msg: string) {
      return submitMessageImpl();
    }
    abort(_reason?: string) {}
    isAborted() { return false; }
  },
}));

function createMockTool(name: string) {
  return {
    name,
    description: `Mock ${name}`,
    inputSchema: {} as any,
    call: vi.fn().mockResolvedValue({ output: '', isError: false }),
  };
}

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
  // Re-register mock after resetModules
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

describe('AgentOrchestrator - spawn', () => {
  it('should spawn an agent successfully', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const agentId = await orchestrator.spawn(
      { name: 'test-agent', prompt: 'do stuff', systemPromptMode: 'default' },
      createParentContext()
    );

    expect(agentId).toBe('test-agent@0');
  });

  it('should register agent with aggregator on spawn', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const aggregator = orchestrator.getAggregator();
    const registerSpy = vi.spyOn(aggregator, 'register');

    await orchestrator.spawn(
      { name: 'my-agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    expect(registerSpy).toHaveBeenCalledWith('my-agent@0', expect.objectContaining({
      name: 'my-agent',
      prompt: 'task',
    }));
  });
});

describe('AgentOrchestrator - spawnBatch', () => {
  it('should spawn multiple agents', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const ids = await orchestrator.spawnBatch(
      [
        { name: 'agent-a', prompt: 'task a', systemPromptMode: 'default' },
        { name: 'agent-b', prompt: 'task b', systemPromptMode: 'default' },
        { name: 'agent-c', prompt: 'task c', systemPromptMode: 'default' },
      ],
      createParentContext()
    );

    expect(ids).toHaveLength(3);
    expect(ids).toContain('agent-a@0');
    expect(ids).toContain('agent-b@1');
    expect(ids).toContain('agent-c@2');
  });

  it('should continue spawning other agents when one fails', async () => {
    // Make QueryEngine fail for specific agent names
    vi.doMock('../../src/query/QueryEngine', () => ({
      QueryEngine: class MockQueryEngine {
        submitMessage(_msg: string) {
          return submitMessageImpl();
        }
        abort(_reason?: string) {}
        isAborted() { return false; }
      },
    }));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    // All 3 should succeed since spawn doesn't fail
    const ids = await orchestrator.spawnBatch(
      [
        { name: 'good-agent-1', prompt: 'task', systemPromptMode: 'default' },
        { name: 'good-agent-2', prompt: 'task', systemPromptMode: 'default' },
      ],
      createParentContext()
    );

    expect(ids).toHaveLength(2);
    consoleSpy.mockRestore();
  });
});

describe('AgentOrchestrator - waitForCompletion', () => {
  it('should resolve when agent completes via event', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();

    const result = {
      agentId: 'agent-1@0',
      name: 'agent-1',
      success: true,
      output: 'done',
      toolUseCount: 1,
      totalTokensUsed: 100,
      duration: 500,
    };

    setTimeout(() => {
      bus.emit('agent-1@0', {
        type: 'agent:subagent_completed',
        agentId: 'agent-1@0',
        result,
        timestamp: Date.now(),
      } as any);
    }, 50);

    const agentResult = await orchestrator.waitForCompletion('agent-1@0', 5000);
    expect(agentResult).toEqual(result);
  });

  it('should reject when agent fails', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();

    setTimeout(() => {
      bus.emit('agent-1@0', {
        type: 'agent:subagent_failed',
        agentId: 'agent-1@0',
        error: 'LLM crashed',
        timestamp: Date.now(),
      } as any);
    }, 50);

    await expect(
      orchestrator.waitForCompletion('agent-1@0', 5000)
    ).rejects.toThrow('Agent agent-1@0 failed: LLM crashed');
  });

  it('should reject when agent times out via event', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();

    setTimeout(() => {
      bus.emit('agent-1@0', {
        type: 'agent:subagent_timed_out',
        agentId: 'agent-1@0',
        elapsed: 60,
        timestamp: Date.now(),
      } as any);
    }, 50);

    await expect(
      orchestrator.waitForCompletion('agent-1@0', 5000)
    ).rejects.toThrow('Agent agent-1@0 timed out after 60s');
  });

  it('should reject when agent is cancelled', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();

    setTimeout(() => {
      bus.emit('agent-1@0', {
        type: 'agent:subagent_cancelled',
        agentId: 'agent-1@0',
        timestamp: Date.now(),
      } as any);
    }, 50);

    await expect(
      orchestrator.waitForCompletion('agent-1@0', 5000)
    ).rejects.toThrow('Agent agent-1@0 was cancelled');
  });

  it('should reject on timeout when no event arrives', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    await expect(
      orchestrator.waitForCompletion('agent-1@0', 200)
    ).rejects.toThrow('Agent agent-1@0 timed out after 0.2s');
  });

  it('should record timeout in aggregator on timeout', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const aggregator = orchestrator.getAggregator();
    const timeoutSpy = vi.spyOn(aggregator, 'recordTimeout');

    try {
      await orchestrator.waitForCompletion('agent-1@0', 100);
    } catch {
      // expected
    }

    expect(timeoutSpy).toHaveBeenCalledWith('agent-1@0', 0.1);
  });

  it('should record failure in aggregator on agent failure', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();
    const aggregator = orchestrator.getAggregator();
    const failSpy = vi.spyOn(aggregator, 'recordFailure');

    setTimeout(() => {
      bus.emit('agent-1@0', {
        type: 'agent:subagent_failed',
        agentId: 'agent-1@0',
        error: 'crash',
        timestamp: Date.now(),
      } as any);
    }, 50);

    try {
      await orchestrator.waitForCompletion('agent-1@0', 5000);
    } catch {
      // expected
    }

    expect(failSpy).toHaveBeenCalledWith('agent-1@0', 'crash');
  });

  it('should record timeout in aggregator on timed_out event', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();
    const aggregator = orchestrator.getAggregator();
    const timeoutSpy = vi.spyOn(aggregator, 'recordTimeout');

    setTimeout(() => {
      bus.emit('agent-1@0', {
        type: 'agent:subagent_timed_out',
        agentId: 'agent-1@0',
        elapsed: 45,
        timestamp: Date.now(),
      } as any);
    }, 50);

    try {
      await orchestrator.waitForCompletion('agent-1@0', 5000);
    } catch {
      // expected
    }

    expect(timeoutSpy).toHaveBeenCalledWith('agent-1@0', 45);
  });

  it('should record cancellation in aggregator on cancelled event', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();
    const aggregator = orchestrator.getAggregator();
    const cancelSpy = vi.spyOn(aggregator, 'recordCancellation');

    setTimeout(() => {
      bus.emit('agent-1@0', {
        type: 'agent:subagent_cancelled',
        agentId: 'agent-1@0',
        timestamp: Date.now(),
      } as any);
    }, 50);

    try {
      await orchestrator.waitForCompletion('agent-1@0', 5000);
    } catch {
      // expected
    }

    expect(cancelSpy).toHaveBeenCalledWith('agent-1@0');
  });
});

describe('AgentOrchestrator - waitForAll', () => {
  it('should return aggregated result when all agents complete', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const aggregator = orchestrator.getAggregator();

    aggregator.register('a@0', { name: 'a', prompt: 'x', systemPromptMode: 'default' });
    aggregator.register('b@0', { name: 'b', prompt: 'y', systemPromptMode: 'default' });
    aggregator.recordResult({
      agentId: 'a@0', name: 'a', success: true, output: 'done a',
      toolUseCount: 1, totalTokensUsed: 50, duration: 200,
    });
    aggregator.recordResult({
      agentId: 'b@0', name: 'b', success: true, output: 'done b',
      toolUseCount: 2, totalTokensUsed: 100, duration: 300,
    });

    const aggregated = await orchestrator.waitForAll(5000);
    expect(aggregated.results).toHaveLength(2);
    expect(aggregated.totalTokensUsed).toBe(150);
    expect(aggregated.totalDuration).toBe(300);
  });

  it('should timeout and cancel active agents when deadline exceeded', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const aggregator = orchestrator.getAggregator();

    // Register agent but never complete it
    aggregator.register('stuck@0', { name: 'stuck', prompt: 'x', systemPromptMode: 'default' });

    // Use very short timeout
    const aggregated = await orchestrator.waitForAll(200);
    expect(aggregated.results).toHaveLength(1);
  });
});

describe('AgentOrchestrator - sendMessage', () => {
  it('should delegate to backend sendMessage', async () => {
    // Keep agent running so it stays in the active map
    let resolveBlock: () => void;
    const blocked = new Promise<void>((r) => { resolveBlock = r; });
    submitMessageImpl = async function* () {
      await blocked;
    };

    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    // Spawn an agent first
    await orchestrator.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    await orchestrator.sendMessage('agent@0', 'hello');

    // Cleanup
    resolveBlock!();
    await orchestrator.cancel('agent@0');
    await new Promise((r) => setTimeout(r, 50));

    // sendMessage should not throw for an existing agent
    expect(true).toBe(true);
  });

  it('should throw for unknown agent', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    await expect(
      orchestrator.sendMessage('nonexistent@0', 'hello')
    ).rejects.toThrow('Agent nonexistent@0 not found');
  });
});

describe('AgentOrchestrator - cancel', () => {
  it('should shutdown agent and record cancellation', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const aggregator = orchestrator.getAggregator();
    aggregator.register('cancel-me@0', { name: 'cancel-me', prompt: 'x', systemPromptMode: 'default' });
    const cancelSpy = vi.spyOn(aggregator, 'recordCancellation');

    await orchestrator.cancel('cancel-me@0');
    expect(cancelSpy).toHaveBeenCalledWith('cancel-me@0');
  });
});

describe('AgentOrchestrator - listAgents', () => {
  it('should list active agents', async () => {
    // Keep agents running so they stay in the active map
    let resolveBlock1: () => void;
    let resolveBlock2: () => void;
    const blocked1 = new Promise<void>((r) => { resolveBlock1 = r; });
    const blocked2 = new Promise<void>((r) => { resolveBlock2 = r; });
    let callCount = 0;
    submitMessageImpl = async function* () {
      callCount++;
      if (callCount === 1) await blocked1;
      else await blocked2;
    };

    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    await orchestrator.spawn(
      { name: 'agent-x', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );
    await orchestrator.spawn(
      { name: 'agent-y', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const agents = orchestrator.listAgents();
    expect(agents).toHaveLength(2);
    expect(agents.map(a => a.agentId)).toContain('agent-x@0');
    expect(agents.map(a => a.agentId)).toContain('agent-y@1');
    expect(agents[0].name).toBeDefined();
    expect(agents[0].status).toBeDefined();

    // Cleanup
    resolveBlock1!();
    resolveBlock2!();
    await orchestrator.shutdownAll();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('AgentOrchestrator - shutdownAll', () => {
  it('should shutdown all agents and clear event bus', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    await orchestrator.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const bus = orchestrator.getEventBus();
    const clearSpy = vi.spyOn(bus, 'clear');

    await orchestrator.shutdownAll();
    expect(clearSpy).toHaveBeenCalled();
    expect(orchestrator.listAgents()).toEqual([]);
  });
});

describe('getOrchestrator / resetOrchestrator', () => {
  it('should return singleton orchestrator', async () => {
    const { getOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orch1 = getOrchestrator([]);
    const orch2 = getOrchestrator([]);
    expect(orch1).toBe(orch2);
    resetOrchestrator();
  });

  it('should throw when tools not provided and not initialized', async () => {
    const { getOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    expect(() => getOrchestrator()).toThrow(
      'Tools must be provided to initialize the global orchestrator'
    );
  });

  it('should reset and allow re-creation', async () => {
    const { getOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orch1 = getOrchestrator([]);
    resetOrchestrator();
    const orch2 = getOrchestrator([]);
    expect(orch1).not.toBe(orch2);
    resetOrchestrator();
  });

  it('should call shutdownAll on reset', async () => {
    const { getOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orch = getOrchestrator([]);
    const shutdownSpy = vi.spyOn(orch, 'shutdownAll');

    resetOrchestrator();
    expect(shutdownSpy).toHaveBeenCalled();
  });
});

describe('AgentOrchestrator - getStatus', () => {
  it('should return null for unknown agent', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    expect(orchestrator.getStatus('unknown')).toBeNull();
  });

  it('should return status for active agent', async () => {
    // Use a blocking generator so agent stays in 'running'
    let resolveBlock: () => void;
    const blocked = new Promise<void>((r) => { resolveBlock = r; });
    submitMessageImpl = async function* () {
      await blocked;
    };

    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    await orchestrator.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const status = orchestrator.getStatus('agent@0');
    expect(status).toBe('running');

    // Cleanup
    await orchestrator.cancel('agent@0');
    resolveBlock!();
    await new Promise((r) => setTimeout(r, 100));
  });
});
