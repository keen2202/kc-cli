import { describe, it, expect, beforeEach } from 'vitest';
import { initializeState } from '../../src/bootstrap/state';

beforeEach(() => {
  initializeState();
  process.env.KC_API_KEY = 'test-key';
});

describe('AgentOrchestrator Integration', () => {
  it('should construct orchestrator with tools', async () => {
    const { AgentOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    const mockTools = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const orch = new AgentOrchestrator(mockTools);
    expect(orch).toBeDefined();
  });

  it('should shutdown all agents', async () => {
    const { AgentOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    const mockTools = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const orch = new AgentOrchestrator(mockTools);
    await orch.shutdownAll();
    expect(orch.listAgents()).toEqual([]);
  });

  it('should shutdown all with force', async () => {
    const { AgentOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    const mockTools = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const orch = new AgentOrchestrator(mockTools);
    await orch.shutdownAll(true);
    expect(orch.listAgents()).toEqual([]);
  });

  it('should return null status for unknown agent', async () => {
    const { AgentOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    const orch = new AgentOrchestrator([]);
    expect(orch.getStatus('nonexistent')).toBeNull();
  });

  it('should provide event bus access', async () => {
    const { AgentOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    const orch = new AgentOrchestrator([]);
    const bus = orch.getEventBus();
    expect(bus).toBeDefined();
  });

  it('should provide aggregator access', async () => {
    const { AgentOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    const orch = new AgentOrchestrator([]);
    const agg = orch.getAggregator();
    expect(agg).toBeDefined();
  });

  it('should list empty agents initially', async () => {
    const { AgentOrchestrator } = await import(
      '../../src/orchestrator/agent-orchestrator'
    );
    const mockTools = [
      { name: 'FileRead', call: async () => ({ output: '', isError: false }), inputSchema: {} },
    ];
    const orch = new AgentOrchestrator(mockTools);
    expect(orch.listAgents()).toEqual([]);
  });
});

describe('ResultAggregator Integration', () => {
  it('should register and report agents', async () => {
    const { ResultAggregator } = await import(
      '../../src/orchestrator/result-aggregator'
    );
    const agg = new ResultAggregator();
    agg.register('agent-1', { name: 'test', prompt: 'do work' });
    agg.register('agent-2', { name: 'helper', prompt: 'assist' });
    expect(agg).toBeDefined();
  });

  it('should generate summary for registered agents', async () => {
    const { ResultAggregator } = await import(
      '../../src/orchestrator/result-aggregator'
    );
    const agg = new ResultAggregator();
    agg.register('agent-1', { name: 'a', prompt: 'p' });
    const summary = agg.generateSummary();
    expect(Array.isArray(summary.results)).toBe(true);
    expect(summary.totalDuration).toBe(0);
  });
});

describe('Agent Definitions', () => {
  it('should list all built-in types', async () => {
    const { listAgentTypes } = await import(
      '../../src/orchestrator/agent-definitions'
    );
    const types = listAgentTypes();
    expect(types.length).toBeGreaterThanOrEqual(5);
    expect(types).toContain('general');
    expect(types).toContain('researcher');
  });

  it('should get valid definition for known type', async () => {
    const { getAgentDefinition } = await import(
      '../../src/orchestrator/agent-definitions'
    );
    const def = getAgentDefinition('general');
    expect(def).not.toBeNull();
  });
});
