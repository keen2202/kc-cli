import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockOrchestrator = {
  spawn: vi.fn(),
  spawnBatch: vi.fn(),
  waitForAll: vi.fn(),
  shutdownAll: vi.fn(),
  listAgents: vi.fn().mockReturnValue([]),
  getEventBus: vi.fn().mockReturnValue({}),
  getAggregator: vi.fn().mockReturnValue({}),
};

const { getOrchestrator } = await import('../../src/orchestrator/agent-orchestrator');

vi.mock('../../src/orchestrator/agent-orchestrator', () => ({
  getOrchestrator: vi.fn().mockReturnValue(mockOrchestrator),
  resetOrchestrator: vi.fn(),
}));

vi.mock('../../src/orchestrator/agent-definitions', () => ({
  createAgentConfig: vi.fn().mockImplementation((type: string, prompt: string, overrides?: any) => {
    const known = ['researcher', 'implementer', 'verifier', 'explorer', 'general'];
    if (!known.includes(type)) return null;
    return {
      name: overrides?.name || `${type}-default`,
      prompt,
      systemPromptMode: 'default',
      tools: overrides?.tools,
      deniedTools: overrides?.deniedTools,
      maxTurns: overrides?.maxTurns || 15,
      timeoutSeconds: overrides?.timeoutSeconds || 300,
    };
  }),
}));

beforeEach(async () => {
  // Initialize state for the tool to work
  const state = await import('../../src/bootstrap/state');
  state.initializeState({ cwd: '/test', permissionMode: 'default' });

  // Reset orchestrator mock
  vi.mocked(getOrchestrator).mockReturnValue(mockOrchestrator);
  mockOrchestrator.spawn.mockReset().mockResolvedValue('agent-id');
  mockOrchestrator.waitForAll.mockReset().mockResolvedValue({
    results: [],
    totalDuration: 0,
    totalTokensUsed: 0,
    totalToolUses: 0,
    summary: 'No agents.',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TeamCreate tool - basic properties', () => {
  it('should have correct name', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    expect(tool.name).toBe('TeamCreate');
  });

  it('should have description', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    expect(tool.description).toContain('Spawn multiple sub-agents');
  });

  it('should not be read-only', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    expect(tool.isReadOnly!({} as any)).toBe(false);
  });

  it('should not be concurrency safe', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    expect(tool.isConcurrencySafe!({} as any)).toBe(false);
  });

  it('should not be destructive', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    expect(tool.isDestructive!({} as any)).toBe(false);
  });

  it('should return prompt text', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    expect(tool.prompt!({} as any)).toContain('Spawn multiple sub-agents');
  });

  it('should return tool use summary', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    const summary = tool.getToolUseSummary!({ agents: [{ name: 'a' }, { name: 'b' }] } as any);
    expect(summary).toBe('TeamCreate: 2 agent(s)');
  });

  it('should return activity description', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    const desc = tool.getActivityDescription!({ agents: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] } as any);
    expect(desc).toBe('Creating team of 3 agents');
  });
});

describe('TeamCreate tool - checkPermissions', () => {
  it('should return ask permission with agent count', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');
    const result = tool.checkPermissions!({ agents: [{ name: 'a' }, { name: 'b' }] } as any, {} as any);
    expect(result).toEqual({
      behavior: 'ask',
      message: 'Create team with 2 agent(s)',
    });
  });
});

describe('TeamCreate tool - call with wait_for_all=false', () => {
  it('should spawn agents and return immediately', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [
          { name: 'researcher-1', prompt: 'find bugs' },
          { name: 'verifier-1', prompt: 'run tests' },
        ],
        wait_for_all: false,
      },
      {} as any
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Team created: 2 agent(s) spawned');
    expect(result.metadata?.agent_ids).toHaveLength(2);
    expect(result.metadata?.total).toBe(2);
    expect(result.metadata?.wait_for_all).toBe(false);
    expect(mockOrchestrator.waitForAll).not.toHaveBeenCalled();
  });

  it('should spawn agent with agent_type when provided', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [
          {
            name: 'my-researcher',
            agent_type: 'researcher',
            prompt: 'explore codebase',
          },
        ],
        wait_for_all: false,
      },
      {} as any
    );

    expect(result.isError).toBe(false);
    expect(mockOrchestrator.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'my-researcher',
        prompt: 'explore codebase',
      }),
      expect.anything()
    );
  });

  it('should handle unknown agent_type gracefully', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [
          {
            name: 'custom',
            agent_type: 'nonexistent-type',
            prompt: 'do something',
          },
        ],
        wait_for_all: false,
      },
      {} as any
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain('Failed to spawn any agents');
    expect(result.message).toContain('Unknown agent type nonexistent-type');
  });

  it('should include errors in output when some agents fail to spawn', async () => {
    mockOrchestrator.spawn
      .mockResolvedValueOnce('good@default')
      .mockRejectedValueOnce(new Error('spawn failed'));

    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [
          { name: 'good', prompt: 'task' },
          { name: 'bad', prompt: 'task' },
        ],
        wait_for_all: false,
      },
      {} as any
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Team created: 1 agent(s) spawned');
    expect(result.output).toContain('Errors (1)');
    expect(result.output).toContain('spawn failed');
    expect(result.metadata?.errors).toBe(1);
  });

  it('should pass tools_allow and tools_deny to config', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    await tool.call(
      {
        agents: [
          {
            name: 'limited',
            prompt: 'task',
            tools_allow: ['FileRead', 'Grep'],
            tools_deny: ['Bash'],
          },
        ],
        wait_for_all: false,
      },
      {} as any
    );

    expect(mockOrchestrator.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: ['FileRead', 'Grep'],
        deniedTools: ['Bash'],
      }),
      expect.anything()
    );
  });

  it('should pass max_turns and timeout to config', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    await tool.call(
      {
        agents: [
          {
            name: 'limited',
            prompt: 'task',
            max_turns: 5,
            timeout: 60,
          },
        ],
        wait_for_all: false,
      },
      {} as any
    );

    expect(mockOrchestrator.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 5,
        timeoutSeconds: 60,
      }),
      expect.anything()
    );
  });
});

describe('TeamCreate tool - call with wait_for_all=true', () => {
  it('should wait for all agents and return aggregated results', async () => {
    mockOrchestrator.waitForAll.mockResolvedValue({
      results: [
        {
          agentId: 'agent-1@default',
          name: 'agent-1',
          success: true,
          output: 'Found 5 bugs',
          toolUseCount: 3,
          totalTokensUsed: 1500,
          duration: 5000,
        },
        {
          agentId: 'agent-2@default',
          name: 'agent-2',
          success: false,
          output: 'Error output',
          toolUseCount: 1,
          totalTokensUsed: 500,
          duration: 2000,
          error: 'timeout',
        },
      ],
      totalDuration: 5000,
      totalTokensUsed: 2000,
      totalToolUses: 4,
      summary: 'All done.',
    });

    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [
          { name: 'agent-1', prompt: 'task 1' },
          { name: 'agent-2', prompt: 'task 2' },
        ],
        wait_for_all: true,
      },
      {} as any
    );

    expect(result.isError).toBe(false);
    expect(result.output).toContain('Team execution completed');
    expect(result.output).toContain('Success: 1');
    expect(result.output).toContain('Failed: 1');
    expect(result.output).toContain('All done.');
    expect(result.metadata?.wait_for_all).toBe(true);
    expect(result.metadata?.success).toBe(1);
    expect(result.metadata?.failed).toBe(1);
    expect(result.metadata?.total_tokens).toBe(2000);
  });

  it('should use custom timeout for wait_for_all', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    await tool.call(
      {
        agents: [{ name: 'agent', prompt: 'task' }],
        wait_for_all: true,
        timeout: 120,
      },
      {} as any
    );

    expect(mockOrchestrator.waitForAll).toHaveBeenCalledWith(120000);
  });

  it('should use default timeout of 600 seconds', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    await tool.call(
      {
        agents: [{ name: 'agent', prompt: 'task' }],
        wait_for_all: true,
      },
      {} as any
    );

    expect(mockOrchestrator.waitForAll).toHaveBeenCalledWith(600000);
  });
});

describe('TeamCreate tool - error handling', () => {
  it('should return error when no agents could be spawned', async () => {
    mockOrchestrator.spawn.mockRejectedValue(new Error('all failed'));

    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [{ name: 'agent', prompt: 'task' }],
        wait_for_all: false,
      },
      {} as any
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain('Failed to spawn any agents');
  });

  it('should handle top-level errors gracefully', async () => {
    vi.mocked(getOrchestrator).mockImplementation(() => {
      throw new Error('Orchestrator not initialized');
    });

    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [{ name: 'agent', prompt: 'task' }],
        wait_for_all: false,
      },
      {} as any
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain('Team creation failed');
    expect(result.message).toContain('Orchestrator not initialized');
  });

  it('should handle non-Error exceptions', async () => {
    vi.mocked(getOrchestrator).mockImplementation(() => {
      throw 'string error';
    });

    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [{ name: 'agent', prompt: 'task' }],
        wait_for_all: false,
      },
      {} as any
    );

    expect(result.isError).toBe(true);
    expect(result.message).toContain('Team creation failed');
  });
});

describe('TeamCreate tool - mixed agent_type and generic agents', () => {
  it('should handle mix of typed and generic agents', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    const result = await tool.call(
      {
        agents: [
          { name: 'typed', agent_type: 'researcher', prompt: 'research' },
          { name: 'generic', prompt: 'do stuff' },
        ],
        wait_for_all: false,
      },
      {} as any
    );

    expect(result.isError).toBe(false);
    expect(mockOrchestrator.spawn).toHaveBeenCalledTimes(2);
    expect(result.metadata?.total).toBe(2);
  });

  it('should pass agent-specific overrides for typed agents', async () => {
    const { tool } = await import('../../src/orchestrator/team-create-tool');

    await tool.call(
      {
        agents: [
          {
            name: 'custom-researcher',
            agent_type: 'researcher',
            prompt: 'research',
            max_turns: 10,
            timeout: 120,
            tools_allow: ['FileRead'],
            tools_deny: ['Bash'],
          },
        ],
        wait_for_all: false,
      },
      {} as any
    );

    expect(mockOrchestrator.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'custom-researcher',
        prompt: 'research',
        maxTurns: 10,
        timeoutSeconds: 120,
        tools: ['FileRead'],
        deniedTools: ['Bash'],
      }),
      expect.anything()
    );
  });
});
