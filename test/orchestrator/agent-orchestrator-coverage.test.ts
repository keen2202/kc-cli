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

    expect(agentId).toBe('test-agent@default');
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

    expect(registerSpy).toHaveBeenCalledWith('my-agent@default', expect.objectContaining({
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
    expect(ids).toContain('agent-a@default');
    expect(ids).toContain('agent-b@default');
    expect(ids).toContain('agent-c@default');
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
      agentId: 'agent-1@default',
      name: 'agent-1',
      success: true,
      output: 'done',
      toolUseCount: 1,
      totalTokensUsed: 100,
      duration: 500,
    };

    setTimeout(() => {
      bus.emit('agent-1@default', {
        type: 'agent:subagent_completed',
        agentId: 'agent-1@default',
        result,
        timestamp: Date.now(),
      } as any);
    }, 50);

    const agentResult = await orchestrator.waitForCompletion('agent-1@default', 5000);
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
      bus.emit('agent-1@default', {
        type: 'agent:subagent_failed',
        agentId: 'agent-1@default',
        error: 'LLM crashed',
        timestamp: Date.now(),
      } as any);
    }, 50);

    await expect(
      orchestrator.waitForCompletion('agent-1@default', 5000)
    ).rejects.toThrow('Agent agent-1@default failed: LLM crashed');
  });

  it('should reject when agent times out via event', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();

    setTimeout(() => {
      bus.emit('agent-1@default', {
        type: 'agent:subagent_timed_out',
        agentId: 'agent-1@default',
        elapsed: 60,
        timestamp: Date.now(),
      } as any);
    }, 50);

    await expect(
      orchestrator.waitForCompletion('agent-1@default', 5000)
    ).rejects.toThrow('Agent agent-1@default timed out after 60s');
  });

  it('should reject when agent is cancelled', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);
    const bus = orchestrator.getEventBus();

    setTimeout(() => {
      bus.emit('agent-1@default', {
        type: 'agent:subagent_cancelled',
        agentId: 'agent-1@default',
        timestamp: Date.now(),
      } as any);
    }, 50);

    await expect(
      orchestrator.waitForCompletion('agent-1@default', 5000)
    ).rejects.toThrow('Agent agent-1@default was cancelled');
  });

  it('should reject on timeout when no event arrives', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    await expect(
      orchestrator.waitForCompletion('agent-1@default', 200)
    ).rejects.toThrow('Agent agent-1@default timed out after 0.2s');
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
      await orchestrator.waitForCompletion('agent-1@default', 100);
    } catch {
      // expected
    }

    expect(timeoutSpy).toHaveBeenCalledWith('agent-1@default', 0.1);
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
      bus.emit('agent-1@default', {
        type: 'agent:subagent_failed',
        agentId: 'agent-1@default',
        error: 'crash',
        timestamp: Date.now(),
      } as any);
    }, 50);

    try {
      await orchestrator.waitForCompletion('agent-1@default', 5000);
    } catch {
      // expected
    }

    expect(failSpy).toHaveBeenCalledWith('agent-1@default', 'crash');
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
      bus.emit('agent-1@default', {
        type: 'agent:subagent_timed_out',
        agentId: 'agent-1@default',
        elapsed: 45,
        timestamp: Date.now(),
      } as any);
    }, 50);

    try {
      await orchestrator.waitForCompletion('agent-1@default', 5000);
    } catch {
      // expected
    }

    expect(timeoutSpy).toHaveBeenCalledWith('agent-1@default', 45);
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
      bus.emit('agent-1@default', {
        type: 'agent:subagent_cancelled',
        agentId: 'agent-1@default',
        timestamp: Date.now(),
      } as any);
    }, 50);

    try {
      await orchestrator.waitForCompletion('agent-1@default', 5000);
    } catch {
      // expected
    }

    expect(cancelSpy).toHaveBeenCalledWith('agent-1@default');
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

    aggregator.register('a@default', { name: 'a', prompt: 'x', systemPromptMode: 'default' });
    aggregator.register('b@default', { name: 'b', prompt: 'y', systemPromptMode: 'default' });
    aggregator.recordResult({
      agentId: 'a@default', name: 'a', success: true, output: 'done a',
      toolUseCount: 1, totalTokensUsed: 50, duration: 200,
    });
    aggregator.recordResult({
      agentId: 'b@default', name: 'b', success: true, output: 'done b',
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
    aggregator.register('stuck@default', { name: 'stuck', prompt: 'x', systemPromptMode: 'default' });

    // Use very short timeout
    const aggregated = await orchestrator.waitForAll(200);
    expect(aggregated.results).toHaveLength(1);
  });
});

describe('AgentOrchestrator - sendMessage', () => {
  it('should delegate to backend sendMessage', async () => {
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

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await orchestrator.sendMessage('agent@default', 'hello');

    expect(consoleSpy).toHaveBeenCalledWith(
      'Message to agent@default:',
      expect.objectContaining({
        type: 'user_message',
        from: 'parent',
        payload: { message: 'hello' },
      })
    );
    consoleSpy.mockRestore();
  });

  it('should throw for unknown agent', async () => {
    const { AgentOrchestrator, resetOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    resetOrchestrator();

    const orchestrator = new AgentOrchestrator([]);

    await expect(
      orchestrator.sendMessage('nonexistent@default', 'hello')
    ).rejects.toThrow('Agent nonexistent@default not found');
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
    aggregator.register('cancel-me@default', { name: 'cancel-me', prompt: 'x', systemPromptMode: 'default' });
    const cancelSpy = vi.spyOn(aggregator, 'recordCancellation');

    await orchestrator.cancel('cancel-me@default');
    expect(cancelSpy).toHaveBeenCalledWith('cancel-me@default');
  });
});

describe('AgentOrchestrator - listAgents', () => {
  it('should list active agents', async () => {
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
    expect(agents.map(a => a.agentId)).toContain('agent-x@default');
    expect(agents.map(a => a.agentId)).toContain('agent-y@default');
    expect(agents[0].name).toBeDefined();
    expect(agents[0].status).toBeDefined();
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

    const status = orchestrator.getStatus('agent@default');
    expect(status).toBe('running');

    // Cleanup
    await orchestrator.cancel('agent@default');
    resolveBlock!();
    await new Promise((r) => setTimeout(r, 100));
  });
});
