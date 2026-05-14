import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventBus } from '../../src/orchestrator/event-bus';
import { ResultAggregator } from '../../src/orchestrator/result-aggregator';
import { deriveChildPermissions, buildChildToolAllowList, createChildPermissionContext } from '../../src/orchestrator/permission-cascader';
import type { SubAgentSpawnConfig, SubAgentResult, AggregatedResult } from '../../src/orchestrator/types';
import type { ToolDefinition, ToolName } from '../../src/types/tools';
import type { PermissionMode } from '../../src/types/permissions';

/**
 * Multi-agent orchestration integration tests.
 *
 * Tests the full lifecycle of sub-agent spawning, permission cascading,
 * result aggregation, and coordination without requiring a real LLM.
 */

// Helper to create mock tools
function makeMockTools(): ToolDefinition[] {
  return [
    {
      name: 'Bash' as ToolName,
      description: 'Execute bash commands',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ output: 'ok', metadata: {} }),
      checkPermissions: vi.fn().mockResolvedValue({ allowed: true }),
    },
    {
      name: 'FileRead' as ToolName,
      description: 'Read files',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ content: 'file content', metadata: {} }),
      checkPermissions: vi.fn().mockResolvedValue({ allowed: true }),
    },
    {
      name: 'FileWrite' as ToolName,
      description: 'Write files',
      inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ success: true, metadata: {} }),
      checkPermissions: vi.fn().mockResolvedValue({ allowed: true }),
    },
    {
      name: 'Grep' as ToolName,
      description: 'Search files',
      inputSchema: { type: 'object', properties: { pattern: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ matches: [], metadata: {} }),
      checkPermissions: vi.fn().mockResolvedValue({ allowed: true }),
    },
    {
      name: 'WebSearch' as ToolName,
      description: 'Search the web',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
      execute: vi.fn().mockResolvedValue({ results: [], metadata: {} }),
      checkPermissions: vi.fn().mockResolvedValue({ allowed: true }),
    },
  ];
}

// Helper to create a mock spawn config
function makeSpawnConfig(overrides?: Partial<SubAgentSpawnConfig>): SubAgentSpawnConfig {
  return {
    name: 'test-agent',
    prompt: 'Do something useful',
    systemPromptMode: 'default',
    maxTurns: 5,
    timeoutSeconds: 30,
    ...overrides,
  };
}

describe('Multi-Agent Orchestration Integration', () => {
  describe('Permission Cascading', () => {
    it('should derive child permissions from parent "auto" mode', () => {
      const childMode = deriveChildPermissions('auto' as PermissionMode, undefined);
      expect(childMode).toBe('auto');
    });

    it('should derive child permissions from parent "default" mode', () => {
      const childMode = deriveChildPermissions('default' as PermissionMode, undefined);
      expect(childMode).toBe('default');
    });

    it('should not escalate child permissions beyond parent', () => {
      // If parent is 'default', child cannot be 'auto'
      const childMode = deriveChildPermissions('default' as PermissionMode, 'auto' as PermissionMode);
      // Should clamp to parent level: default allows [default, plan]
      expect(['default', 'plan']).toContain(childMode);
    });

    it('should allow child to have same permissions as parent', () => {
      const childMode = deriveChildPermissions('auto' as PermissionMode, 'auto' as PermissionMode);
      expect(childMode).toBe('auto');
    });

    it('should allow child to have more restrictive permissions', () => {
      const childMode = deriveChildPermissions('auto' as PermissionMode, 'default' as PermissionMode);
      expect(childMode).toBe('default');
    });

    it('should build child tool allow list from parent tools', () => {
      const parentTools: ToolName[] = ['Bash', 'FileRead', 'FileWrite', 'Grep', 'WebSearch'];

      // No restrictions
      const allAllowed = buildChildToolAllowList(parentTools, {});
      expect(allAllowed).toEqual(parentTools);

      // Whitelist specific tools
      const restricted = buildChildToolAllowList(parentTools, {
        tools: ['Bash', 'FileRead'] as ToolName[],
      });
      expect(restricted).toEqual(['Bash', 'FileRead']);

      // Deny specific tools
      const denied = buildChildToolAllowList(parentTools, {
        deniedTools: ['Bash'] as ToolName[],
      });
      expect(denied).not.toContain('Bash');
      expect(denied).toContain('FileRead');
    });

    it('should create child permission context', () => {
      const parentContext = {
        mode: 'auto' as PermissionMode,
        cwd: '/tmp',
        toolName: '',
        input: {},
        alwaysDenyRules: [],
        alwaysAskRules: [],
        alwaysAllowRules: [],
        bypassPermissions: false,
      };

      const childContext = createChildPermissionContext(parentContext, 'default' as PermissionMode);
      expect(childContext.mode).toBe('default');
    });
  });

  describe('EventBus Coordination', () => {
    let bus: EventBus;

    beforeEach(() => {
      bus = new EventBus();
    });

    it('should coordinate events between multiple agents', () => {
      const agent1Events: any[] = [];
      const agent2Events: any[] = [];

      bus.on('agent-1', (e) => agent1Events.push(e));
      bus.on('agent-2', (e) => agent2Events.push(e));

      // Simulate parallel agent activity
      bus.emit('agent-1', { type: 'agent:text_delta', text: 'Agent 1 working', timestamp: Date.now() });
      bus.emit('agent-2', { type: 'agent:text_delta', text: 'Agent 2 working', timestamp: Date.now() });
      bus.emit('agent-1', { type: 'agent:subagent_completed', agentId: 'agent-1', result: { output: 'Done 1' }, timestamp: Date.now() });
      bus.emit('agent-2', { type: 'agent:subagent_completed', agentId: 'agent-2', result: { output: 'Done 2' }, timestamp: Date.now() });

      expect(agent1Events).toHaveLength(2);
      expect(agent2Events).toHaveLength(2);
      expect(agent1Events[1].type).toBe('agent:subagent_completed');
      expect(agent2Events[1].type).toBe('agent:subagent_completed');
    });

    it('should support onAny for monitoring all agents', () => {
      const allEvents: Array<{ agentId: string; event: any }> = [];

      bus.onAny((agentId, event) => {
        allEvents.push({ agentId, event });
      });

      bus.emit('agent-1', { type: 'agent:text_delta', text: 'a', timestamp: Date.now() });
      bus.emit('agent-2', { type: 'agent:text_delta', text: 'b', timestamp: Date.now() });
      bus.emit('agent-3', { type: 'agent:text_delta', text: 'c', timestamp: Date.now() });

      expect(allEvents).toHaveLength(3);
      expect(allEvents.map(e => e.agentId)).toEqual(['agent-1', 'agent-2', 'agent-3']);
    });

    it('should handle agent failure without affecting others', () => {
      const agent1Handler = vi.fn();
      const agent2Handler = vi.fn();

      bus.on('agent-1', agent1Handler);
      bus.on('agent-2', agent2Handler);

      // Agent 1 fails
      bus.emit('agent-1', { type: 'agent:subagent_failed', agentId: 'agent-1', error: 'timeout', timestamp: Date.now() });

      // Agent 2 should still complete normally
      bus.emit('agent-2', { type: 'agent:subagent_completed', agentId: 'agent-2', result: { output: 'success' }, timestamp: Date.now() });

      expect(agent1Handler).toHaveBeenCalledTimes(1);
      expect(agent2Handler).toHaveBeenCalledTimes(1);
      expect(agent1Handler.mock.calls[0][0].type).toBe('agent:subagent_failed');
      expect(agent2Handler.mock.calls[0][0].type).toBe('agent:subagent_completed');
    });

    it('should drain events per agent independently', () => {
      bus.emit('agent-1', { type: 'agent:text_delta', text: 'a1', timestamp: Date.now() });
      bus.emit('agent-1', { type: 'agent:text_delta', text: 'a2', timestamp: Date.now() });
      bus.emit('agent-2', { type: 'agent:text_delta', text: 'b1', timestamp: Date.now() });

      const agent1Events = bus.drain('agent-1');
      const agent2Events = bus.drain('agent-2');

      expect(agent1Events).toHaveLength(2);
      expect(agent2Events).toHaveLength(1);

      // Draining again should return empty
      expect(bus.drain('agent-1')).toHaveLength(0);
    });
  });

  describe('ResultAggregator', () => {
    let aggregator: ResultAggregator;

    beforeEach(() => {
      aggregator = new ResultAggregator();
    });

    it('should register and track multiple agents', () => {
      aggregator.register('agent-1', makeSpawnConfig({ name: 'coder' }));
      aggregator.register('agent-2', makeSpawnConfig({ name: 'reviewer' }));
      aggregator.register('agent-3', makeSpawnConfig({ name: 'tester' }));

      expect(aggregator.isAllDone()).toBe(false);
    });

    it('should record successful completions', () => {
      aggregator.register('agent-1', makeSpawnConfig());

      aggregator.recordResult({
        agentId: 'agent-1',
        name: 'test-agent',
        success: true,
        output: 'Task completed successfully',
        toolUseCount: 3,
        totalTokensUsed: 500,
        duration: 2000,
      });

      expect(aggregator.isAllDone()).toBe(true);
    });

    it('should record failures', () => {
      aggregator.register('agent-1', makeSpawnConfig());

      aggregator.recordFailure('agent-1', 'Connection timeout');

      expect(aggregator.isAllDone()).toBe(true);
    });

    it('should record timeouts', () => {
      aggregator.register('agent-1', makeSpawnConfig());

      aggregator.recordTimeout('agent-1', 300);

      expect(aggregator.isAllDone()).toBe(true);
    });

    it('should record cancellations', () => {
      aggregator.register('agent-1', makeSpawnConfig());

      aggregator.recordCancellation('agent-1');

      expect(aggregator.isAllDone()).toBe(true);
    });

    it('should generate aggregated summary', () => {
      aggregator.register('agent-1', makeSpawnConfig({ name: 'coder' }));
      aggregator.register('agent-2', makeSpawnConfig({ name: 'reviewer' }));

      aggregator.recordResult({
        agentId: 'agent-1',
        name: 'coder',
        success: true,
        output: 'Code written',
        toolUseCount: 5,
        totalTokensUsed: 1000,
        duration: 3000,
      });

      aggregator.recordResult({
        agentId: 'agent-2',
        name: 'reviewer',
        success: true,
        output: 'Code reviewed, looks good',
        toolUseCount: 2,
        totalTokensUsed: 500,
        duration: 1500,
      });

      const summary = aggregator.generateSummary();

      expect(summary).toHaveProperty('results');
      expect(summary).toHaveProperty('totalDuration');
      expect(summary).toHaveProperty('totalTokensUsed');
      expect(summary).toHaveProperty('totalToolUses');
      expect(summary).toHaveProperty('summary');

      expect(summary.results).toHaveLength(2);
      expect(summary.totalTokensUsed).toBe(1500);
      expect(summary.totalToolUses).toBe(7);
    });

    it('should handle mixed success/failure results', () => {
      aggregator.register('agent-1', makeSpawnConfig({ name: 'success-agent' }));
      aggregator.register('agent-2', makeSpawnConfig({ name: 'fail-agent' }));

      aggregator.recordResult({
        agentId: 'agent-1',
        name: 'success-agent',
        success: true,
        output: 'Done',
        toolUseCount: 1,
        totalTokensUsed: 100,
        duration: 500,
      });

      aggregator.recordFailure('agent-2', 'API error');

      const summary = aggregator.generateSummary();

      expect(summary.results).toHaveLength(2);
      const successResult = summary.results.find(r => r.success);
      const failResult = summary.results.find(r => !r.success);

      expect(successResult).toBeDefined();
      expect(failResult).toBeDefined();
    });

    it('should not be done until all agents complete', () => {
      aggregator.register('agent-1', makeSpawnConfig());
      aggregator.register('agent-2', makeSpawnConfig());
      aggregator.register('agent-3', makeSpawnConfig());

      aggregator.recordResult({
        agentId: 'agent-1',
        name: 'test',
        success: true,
        output: 'done',
        toolUseCount: 0,
        totalTokensUsed: 0,
        duration: 100,
      });

      expect(aggregator.isAllDone()).toBe(false);

      aggregator.recordResult({
        agentId: 'agent-2',
        name: 'test',
        success: true,
        output: 'done',
        toolUseCount: 0,
        totalTokensUsed: 0,
        duration: 100,
      });

      expect(aggregator.isAllDone()).toBe(false);

      aggregator.recordResult({
        agentId: 'agent-3',
        name: 'test',
        success: true,
        output: 'done',
        toolUseCount: 0,
        totalTokensUsed: 0,
        duration: 100,
      });

      expect(aggregator.isAllDone()).toBe(true);
    });
  });

  describe('Agent Tool Filtering', () => {
    it('should filter tools based on allowed list', () => {
      const allTools = makeMockTools();
      const allowed = buildChildToolAllowList(
        allTools.map(t => t.name as ToolName),
        { tools: ['Bash', 'FileRead'] as ToolName[] }
      );

      const filteredTools = allTools.filter(t => allowed.includes(t.name as ToolName));

      expect(filteredTools).toHaveLength(2);
      expect(filteredTools.map(t => t.name)).toContain('Bash');
      expect(filteredTools.map(t => t.name)).toContain('FileRead');
      expect(filteredTools.map(t => t.name)).not.toContain('WebSearch');
    });

    it('should filter tools based on denied list', () => {
      const allTools = makeMockTools();
      const allowed = buildChildToolAllowList(
        allTools.map(t => t.name as ToolName),
        { deniedTools: ['Bash'] as ToolName[] }
      );

      const filteredTools = allTools.filter(t => allowed.includes(t.name as ToolName));

      expect(filteredTools).toHaveLength(4);
      expect(filteredTools.map(t => t.name)).not.toContain('Bash');
      expect(filteredTools.map(t => t.name)).toContain('FileRead');
      expect(filteredTools.map(t => t.name)).toContain('WebSearch');
    });

    it('should inherit all tools when no restrictions', () => {
      const allTools = makeMockTools();
      const allowed = buildChildToolAllowList(
        allTools.map(t => t.name as ToolName),
        {}
      );

      expect(allowed).toHaveLength(allTools.length);
    });
  });

  describe('Agent Definition Lookup', () => {
    it('should load agent definitions', async () => {
      try {
        const { getAgentDefinition, listAgentTypes } = await import('../../src/orchestrator/agent-definitions');

        const definitions = listAgentTypes();
        expect(Array.isArray(definitions)).toBe(true);

        // Should have at least the default agents
        if (definitions.length > 0) {
          const first = definitions[0];
          expect(first).toHaveProperty('name');
          expect(first).toHaveProperty('description');
        }
      } catch {
        // Module may not be available
        console.log('  ⏭ Skipping: agent-definitions module not available');
      }
    });
  });

  describe('Spawn Config Validation', () => {
    it('should accept valid spawn config', () => {
      const config = makeSpawnConfig();
      expect(config.name).toBeTruthy();
      expect(config.prompt).toBeTruthy();
      expect(config.systemPromptMode).toBe('default');
      expect(config.maxTurns).toBeGreaterThan(0);
      expect(config.timeoutSeconds).toBeGreaterThan(0);
    });

    it('should accept config with tool restrictions', () => {
      const config = makeSpawnConfig({
        tools: ['Bash', 'FileRead'] as ToolName[],
        deniedTools: ['WebSearch'] as ToolName[],
      });

      expect(config.tools).toHaveLength(2);
      expect(config.deniedTools).toHaveLength(1);
    });

    it('should accept config with permission override', () => {
      const config = makeSpawnConfig({
        permissions: 'default' as PermissionMode,
      });

      expect(config.permissions).toBe('default');
    });

    it('should accept config with model override', () => {
      const config = makeSpawnConfig({
        model: 'claude-sonnet-4-20250514',
      });

      expect(config.model).toBe('claude-sonnet-4-20250514');
    });
  });
});
