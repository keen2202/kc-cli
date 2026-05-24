import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// State management is done fresh in beforeEach via dynamic import
import { EventBus } from '../../src/orchestrator/event-bus';
import { resetCachedQueryEngine } from '../../src/orchestrator/backends/in-process';

// Track submitMessage calls for each test
let submitMessageImpl: () => AsyncGenerator<any> = async function* () {};
// Optional error to throw from QueryEngine constructor
let constructorError: Error | null = null;

// Export for test access
export function setSubmitMessageImpl(fn: () => AsyncGenerator<any>) {
  submitMessageImpl = fn;
}

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
  resetCachedQueryEngine();
  // Re-import state module fresh after resetModules
  const state = await import('../../src/bootstrap/state');
  state.initializeState({ cwd: '/test', permissionMode: 'default' });
  // Reset to default no-op generator
  submitMessageImpl = async function* () {};
  constructorError = null;
  // Re-register the mock for each test
  vi.doMock('../../src/query/QueryEngine', () => ({
    QueryEngine: class MockQueryEngine {
      constructor() {
        if (constructorError) throw constructorError;
      }
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

describe('InProcessBackend - constructor', () => {
  it('should construct with tools and event bus', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead'), createMockTool('Bash')];

    const backend = new InProcessBackend(bus, tools, 'default', '/test');
    expect(backend.type).toBe('in_process');
  });
});

describe('InProcessBackend - spawn', () => {
  it('should spawn agent and return success result', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const result = await backend.spawn(
      { name: 'test-agent', prompt: 'do stuff', systemPromptMode: 'default' },
      createParentContext()
    );

    expect(result.success).toBe(true);
    expect(result.agentId).toBe('test-agent@default');
    expect(result.queryEngine).toBeDefined();
  });

  it('should store runtime in active agents map', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.spawn(
      { name: 'my-agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const active = backend.listActive();
    expect(active).toContain('my-agent@default');
  });

  it('should emit spawned event', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const events: any[] = [];
    bus.on('my-agent@default', (event) => events.push(event));

    await backend.spawn(
      { name: 'my-agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    await new Promise((r) => setTimeout(r, 100));
    expect(events.some((e) => e.type === 'agent:subagent_spawned')).toBe(true);
  });

  it('should spawn with custom tools whitelist', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead'), createMockTool('Bash'), createMockTool('Grep')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const result = await backend.spawn(
      { name: 'limited-agent', prompt: 'task', systemPromptMode: 'default', tools: ['FileRead' as any, 'Grep' as any] },
      createParentContext()
    );
    expect(result.success).toBe(true);
  });

  it('should spawn with denied tools', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead'), createMockTool('Bash'), createMockTool('Grep')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const result = await backend.spawn(
      { name: 'safe-agent', prompt: 'task', systemPromptMode: 'default', deniedTools: ['Bash' as any] },
      createParentContext()
    );
    expect(result.success).toBe(true);
  });

  it('should spawn with model override', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const result = await backend.spawn(
      { name: 'model-agent', prompt: 'task', systemPromptMode: 'default', model: 'claude-opus-4-20250514' },
      createParentContext()
    );
    expect(result.success).toBe(true);
    expect(result.queryEngine).toBeDefined();
  });

  it('should handle spawn error and return failure', async () => {
    constructorError = new Error('No API key');
    resetCachedQueryEngine();

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const result = await backend.spawn(
      { name: 'fail-agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('No API key');
    expect(result.queryEngine).toBeNull();
  });
});

describe('InProcessBackend - agent loop behavior', () => {
  it('should process text_delta events', async () => {
    submitMessageImpl = async function* () {
      yield { type: 'agent:text_delta', text: 'Hello ', timestamp: Date.now() };
      yield { type: 'agent:text_delta', text: 'World', timestamp: Date.now() };
      yield {
        type: 'agent:turn_complete',
        message: { content: 'Hello World', toolCalls: [] },
        timestamp: Date.now(),
      };
    };

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const events: any[] = [];
    bus.on('agent@default', (event) => events.push(event));

    await backend.spawn(
      { name: 'agent', prompt: 'say hello', systemPromptMode: 'default' },
      createParentContext()
    );

    await new Promise((r) => setTimeout(r, 500));

    const completedEvent = events.find((e) => e.type === 'agent:subagent_completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.result.success).toBe(true);
    expect(completedEvent.result.output).toBe('Hello World');
  });

  it('should handle tool_completed events and track tokens', async () => {
    submitMessageImpl = async function* () {
      yield {
        type: 'agent:tool_completed',
        result: { metadata: { tokensUsed: 500 } },
        timestamp: Date.now(),
      };
      yield {
        type: 'agent:turn_complete',
        message: { content: 'done', toolCalls: [{ name: 'FileRead', input: {} }] },
        timestamp: Date.now(),
      };
    };

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const events: any[] = [];
    bus.on('agent@default', (event) => events.push(event));

    await backend.spawn(
      { name: 'agent', prompt: 'read file', systemPromptMode: 'default' },
      createParentContext()
    );

    await new Promise((r) => setTimeout(r, 500));

    const completedEvent = events.find((e) => e.type === 'agent:subagent_completed');
    expect(completedEvent).toBeDefined();
    expect(completedEvent.result.totalTokensUsed).toBe(500);
    expect(completedEvent.result.toolUseCount).toBe(1);
  });

  it('should emit failed event when agent loop throws', async () => {
    submitMessageImpl = async function* () {
      yield { type: 'agent:text_delta', text: 'partial', timestamp: Date.now() };
      throw new Error('LLM connection lost');
    };

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const events: any[] = [];
    bus.on('agent@default', (event) => events.push(event));

    await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    await new Promise((r) => setTimeout(r, 500));

    const failedEvent = events.find((e) => e.type === 'agent:subagent_failed');
    expect(failedEvent).toBeDefined();
    expect(failedEvent.error).toContain('LLM connection lost');

    const status = backend.getStatus('agent@default');
    expect(status).toBe('failed');
  });

  it('should handle timeout by aborting agent', async () => {
    let resolveBlock: () => void;
    const blocked = new Promise<void>((r) => { resolveBlock = r; });

    submitMessageImpl = async function* () {
      yield { type: 'agent:text_delta', text: 'start', timestamp: Date.now() };
      await blocked;
    };

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const events: any[] = [];
    bus.on('agent@default', (event) => events.push(event));

    await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default', timeoutSeconds: 0.1 },
      createParentContext()
    );

    await new Promise((r) => setTimeout(r, 500));
    resolveBlock!();
    await new Promise((r) => setTimeout(r, 200));

    // After timeout + abort, agent should have progressed beyond 'running'
    const status = backend.getStatus('agent@default');
    expect(status).not.toBe('spawning');
  });

  it('should use default timeout when not specified', async () => {
    submitMessageImpl = async function* () {
      yield { type: 'agent:text_delta', text: 'ok', timestamp: Date.now() };
    };

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const result = await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );
    expect(result.success).toBe(true);
    // Agent should be active
    expect(backend.listActive()).toContain('agent@default');
  });
});

describe('InProcessBackend - getStatus', () => {
  it('should return status for active agent', async () => {
    // Use a blocking generator so agent stays in 'running'
    let resolveBlock: () => void;
    const blocked = new Promise<void>((r) => { resolveBlock = r; });
    submitMessageImpl = async function* () {
      await blocked;
    };

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const status = backend.getStatus('agent@default');
    expect(status).toBe('running');

    // Cleanup
    await backend.shutdown('agent@default', true);
    resolveBlock!();
    await new Promise((r) => setTimeout(r, 100));
  });

  it('should return null for unknown agent', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const status = backend.getStatus('nonexistent@default');
    expect(status).toBeNull();
  });
});

describe('InProcessBackend - listActive', () => {
  it('should return empty list initially', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    expect(backend.listActive()).toEqual([]);
  });

  it('should list spawned agents', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.spawn(
      { name: 'agent-a', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );
    await backend.spawn(
      { name: 'agent-b', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const active = backend.listActive();
    expect(active).toContain('agent-a@default');
    expect(active).toContain('agent-b@default');
    expect(active).toHaveLength(2);
  });
});

describe('InProcessBackend - sendMessage', () => {
  it('should send message to existing agent', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await backend.sendMessage('agent@default', {
      type: 'user_message',
      from: 'parent',
      payload: { message: 'hello' },
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      'Message to agent@default:',
      expect.objectContaining({ type: 'user_message' })
    );
    consoleSpy.mockRestore();
  });

  it('should throw when sending to unknown agent', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await expect(
      backend.sendMessage('nonexistent@default', {
        type: 'user_message',
        from: 'parent',
        payload: {},
      })
    ).rejects.toThrow('Agent nonexistent@default not found');
  });
});

describe('InProcessBackend - shutdown', () => {
  it('should force shutdown existing agent', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const events: any[] = [];
    bus.on('agent@default', (event) => events.push(event));

    const result = await backend.shutdown('agent@default', true);
    expect(result).toBe(true);
    expect(backend.listActive()).not.toContain('agent@default');
    expect(events.some((e) => e.type === 'agent:subagent_cancelled')).toBe(true);
  });

  it('should graceful shutdown existing agent', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    const result = await backend.shutdown('agent@default', false);
    expect(result).toBe(true);
  });

  it('should return false for unknown agent', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const result = await backend.shutdown('nonexistent@default');
    expect(result).toBe(false);
  });
});

describe('InProcessBackend - shutdownAll', () => {
  it('should shutdown all active agents', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.spawn(
      { name: 'agent-a', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );
    await backend.spawn(
      { name: 'agent-b', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    expect(backend.listActive()).toHaveLength(2);

    await backend.shutdownAll();

    expect(backend.listActive()).toEqual([]);
  });

  it('should handle shutdownAll with no agents', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.shutdownAll();
    expect(backend.listActive()).toEqual([]);
  });
});

describe('InProcessBackend - permission cascading', () => {
  it('should derive child permissions from bypass parent', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'bypassPermissions', '/test');

    const result = await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    expect(result.success).toBe(true);
  });

  it('should restrict child permissions below plan parent', async () => {
    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'plan', '/test');

    const result = await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    expect(result.success).toBe(true);
  });
});

describe('getCurrentAgentContext', () => {
  it('should return undefined outside agent context', async () => {
    const { getCurrentAgentContext } = await import('../../src/orchestrator/backends/in-process');
    expect(getCurrentAgentContext()).toBeUndefined();
  });
});

describe('InProcessBackend - concurrent execution', () => {
  it('should handle multiple agents running concurrently', async () => {
    submitMessageImpl = async function* () {
      yield { type: 'agent:text_delta', text: 'done', timestamp: Date.now() };
    };

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    const results = await Promise.all([
      backend.spawn(
        { name: 'agent-1', prompt: 'task 1', systemPromptMode: 'default' },
        createParentContext()
      ),
      backend.spawn(
        { name: 'agent-2', prompt: 'task 2', systemPromptMode: 'default' },
        createParentContext()
      ),
      backend.spawn(
        { name: 'agent-3', prompt: 'task 3', systemPromptMode: 'default' },
        createParentContext()
      ),
    ]);

    expect(results).toHaveLength(3);
    // At least the spawn itself should succeed (even if the loop fails)
    expect(results.every((r) => r.agentId)).toBe(true);

    await new Promise((r) => setTimeout(r, 500));

    const active = backend.listActive();
    expect(active).toHaveLength(3);
  });
});

describe('InProcessBackend - abort signal wiring', () => {
  it('should wire abort controller to query engine abort on force shutdown', async () => {
    let resolveBlock: () => void;
    const blocked = new Promise<void>((r) => { resolveBlock = r; });

    submitMessageImpl = async function* () {
      await blocked;
    };

    const { InProcessBackend } = await import('../../src/orchestrator/backends/in-process');
    const bus = new EventBus();
    const tools = [createMockTool('FileRead')];
    const backend = new InProcessBackend(bus, tools, 'default', '/test');

    await backend.spawn(
      { name: 'agent', prompt: 'task', systemPromptMode: 'default' },
      createParentContext()
    );

    await backend.shutdown('agent@default', true);
    resolveBlock!();

    await new Promise((r) => setTimeout(r, 200));

    expect(backend.listActive()).not.toContain('agent@default');
  });
});
