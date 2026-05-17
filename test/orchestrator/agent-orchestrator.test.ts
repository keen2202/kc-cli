import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initializeState } from '../../src/bootstrap/state';

beforeEach(() => {
  initializeState();
  process.env.KC_API_KEY = 'test-dummy-key';
});

describe('AgentOrchestrator', () => {
  it('should be constructable with tools', async () => {
    const allTools: any[] = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const { AgentOrchestrator } = await import('../../src/orchestrator/agent-orchestrator');
    const orchestrator = new AgentOrchestrator(allTools);
    expect(orchestrator).toBeDefined();
  });

  it('should have an event bus', async () => {
    const allTools: any[] = [
      { name: 'Grep', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const { AgentOrchestrator } = await import('../../src/orchestrator/agent-orchestrator');
    const orchestrator = new AgentOrchestrator(allTools);
    const eventBus = orchestrator.getEventBus();
    expect(eventBus).toBeDefined();
  });

  it('should have a result aggregator', async () => {
    const allTools: any[] = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const { AgentOrchestrator } = await import('../../src/orchestrator/agent-orchestrator');
    const orchestrator = new AgentOrchestrator(allTools);
    const aggregator = orchestrator.getAggregator();
    expect(aggregator).toBeDefined();
  });

  it('should list agents initially empty', async () => {
    const allTools: any[] = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const { AgentOrchestrator } = await import('../../src/orchestrator/agent-orchestrator');
    const orchestrator = new AgentOrchestrator(allTools);
    const agents = orchestrator.listAgents();
    expect(agents).toEqual([]);
  });

  it('should return null status for unknown agent', async () => {
    const allTools: any[] = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const { AgentOrchestrator } = await import('../../src/orchestrator/agent-orchestrator');
    const orchestrator = new AgentOrchestrator(allTools);
    expect(orchestrator.getStatus('unknown')).toBeNull();
  });

  it('should support shutdownAll', async () => {
    const allTools: any[] = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const { AgentOrchestrator } = await import('../../src/orchestrator/agent-orchestrator');
    const orchestrator = new AgentOrchestrator(allTools);
    await orchestrator.shutdownAll();
    expect(orchestrator.listAgents()).toEqual([]);
  });

  it('should support shutdownAll with force', async () => {
    const allTools: any[] = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const { AgentOrchestrator } = await import('../../src/orchestrator/agent-orchestrator');
    const orchestrator = new AgentOrchestrator(allTools);
    await orchestrator.shutdownAll(true);
    expect(orchestrator.listAgents()).toEqual([]);
  });
});

describe('EventBus', () => {
  it('should create scoped event bus for agent', async () => {
    const { EventBus } = await import('../../src/orchestrator/event-bus');
    const bus = new EventBus();
    const scoped = bus.createScoped('agent-1');
    expect(scoped).toBeDefined();
  });

  it('should subscribe and receive events', () => new Promise<void>(async (done) => {
    const { EventBus } = await import('../../src/orchestrator/event-bus');
    const bus = new EventBus();

    bus.on('agent-1', (event) => {
      expect(event).toBeDefined();
      done();
    });

    bus.emit('agent-1', { type: 'agent:complete', timestamp: Date.now() } as any);
  }));

  it('should forward events through scoped bus', () => new Promise<void>(async (done) => {
    const { EventBus } = await import('../../src/orchestrator/event-bus');
    const bus = new EventBus();

    bus.on('agent-1', (event) => {
      expect(event.type).toBe('agent:text_delta');
      done();
    });

    const scoped = bus.createScoped('agent-1');
    scoped.emit({ type: 'agent:text_delta', text: 'hello', timestamp: Date.now() } as any);
  }));

  it('should not receive events for wrong agent', async () => {
    const { EventBus } = await import('../../src/orchestrator/event-bus');
    const bus = new EventBus();
    let receivedForAgent1 = false;

    bus.on('agent-1', () => {
      receivedForAgent1 = true;
    });

    bus.emit('agent-2', { type: 'agent:complete', timestamp: Date.now() } as any);

    // Allow async delivery
    await new Promise(r => setTimeout(r, 50));
    expect(receivedForAgent1).toBe(false);
  });

  it('should support multiple subscribers for same agent', async () => {
    const { EventBus } = await import('../../src/orchestrator/event-bus');
    const bus = new EventBus();
    const received: string[] = [];

    bus.on('agent-1', () => received.push('sub1'));
    bus.on('agent-1', () => received.push('sub2'));

    bus.emit('agent-1', { type: 'agent:complete', timestamp: Date.now() } as any);

    await new Promise(r => setTimeout(r, 50));
    expect(received).toEqual(['sub1', 'sub2']);
  });

  it('should support unsubscribe', async () => {
    const { EventBus } = await import('../../src/orchestrator/event-bus');
    const bus = new EventBus();
    let callCount = 0;

    const unsub = bus.on('agent-1', () => callCount++);
    unsub();

    bus.emit('agent-1', { type: 'agent:complete', timestamp: Date.now() } as any);

    await new Promise(r => setTimeout(r, 50));
    expect(callCount).toBe(0);
  });

  it('should clear all listeners', async () => {
    const { EventBus } = await import('../../src/orchestrator/event-bus');
    const bus = new EventBus();
    let callCount = 0;

    bus.on('agent-1', () => callCount++);
    bus.on('agent-2', () => callCount++);
    bus.clear();

    bus.emit('agent-1', { type: 'agent:complete', timestamp: Date.now() } as any);
    bus.emit('agent-2', { type: 'agent:complete', timestamp: Date.now() } as any);

    await new Promise(r => setTimeout(r, 50));
    expect(callCount).toBe(0);
  });

  it('should support scoped emit and drain', async () => {
    const { EventBus } = await import('../../src/orchestrator/event-bus');
    const bus = new EventBus();
    const scoped = bus.createScoped('agent-1');

    scoped.emit({ type: 'agent:text_delta', text: 'iter-test', timestamp: Date.now() } as any);
    scoped.emit({ type: 'agent:complete', timestamp: Date.now() } as any);

    const drained = scoped.drain();
    expect(drained.length).toBe(2);
    expect(drained[0].type).toBe('agent:text_delta');
    expect(drained[1].type).toBe('agent:complete');
  });
});

describe('ResultAggregator', () => {
  it('should register agent', async () => {
    const { ResultAggregator } = await import('../../src/orchestrator/result-aggregator');
    const agg = new ResultAggregator();
    agg.register('agent-1', { name: 'test', prompt: 'do stuff' });
    expect(agg).toBeDefined();
  });

  it('should report all done when nothing registered', async () => {
    const { ResultAggregator } = await import('../../src/orchestrator/result-aggregator');
    const agg = new ResultAggregator();
    const summary = agg.generateSummary();
    expect(summary).toBeDefined();
    expect(Array.isArray(summary.results)).toBe(true);
    expect(summary.results).toHaveLength(0);
    expect(summary.totalDuration).toBe(0);
  });
});

describe('PermissionCascader', () => {
  it('should derive child permissions not exceeding parent', async () => {
    const { deriveChildPermissions } = await import('../../src/orchestrator/permission-cascader');
    const childMode = deriveChildPermissions('default');
    expect(childMode).toBe('default');
  });

  it('should maintain bypass when parent has bypass', async () => {
    const { deriveChildPermissions } = await import('../../src/orchestrator/permission-cascader');
    const childMode = deriveChildPermissions('bypassPermissions');
    expect(childMode).toBe('bypassPermissions');
  });

  it('should downgrade dontAsk to child', async () => {
    const { deriveChildPermissions } = await import('../../src/orchestrator/permission-cascader');
    // When parent is dontAsk, child cannot use any tools
    const childMode = deriveChildPermissions('dontAsk');
    expect(childMode).toBe('dontAsk');
  });

  it('should accept requested child mode if allowed', async () => {
    const { deriveChildPermissions } = await import('../../src/orchestrator/permission-cascader');
    // Child can request a more restrictive mode
    const childMode = deriveChildPermissions('default', 'plan');
    expect(childMode).toBeDefined();
  });

  it('should build tool allowlist', async () => {
    const { buildChildToolAllowList } = await import('../../src/orchestrator/permission-cascader');
    const tools = buildChildToolAllowList(['Bash', 'FileRead', 'FileWrite', 'Grep'], {
      tools: ['FileRead', 'Grep'],
    });
    expect(tools).toContain('FileRead' as any);
    expect(tools).toContain('Grep' as any);
    expect(tools).not.toContain('Bash' as any);
  });

  it('should respect deny list over allow list in tool list', async () => {
    const { buildChildToolAllowList } = await import('../../src/orchestrator/permission-cascader');
    const tools = buildChildToolAllowList(['Bash', 'FileRead', 'FileWrite', 'Grep'], {
      tools: ['Bash', 'FileRead'],
      deniedTools: ['Bash'],
    });
    expect(tools).toContain('FileRead' as any);
    expect(tools).not.toContain('Bash' as any);
  });
});
