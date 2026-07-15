import { describe, it, expect, beforeEach } from 'vitest';
import { ResultAggregator } from '../../src/orchestrator/result-aggregator';
import type { SubAgentResult } from '../../src/types/orchestrator';

describe('ResultAggregator', () => {
  let agg: ResultAggregator;

  beforeEach(() => {
    agg = new ResultAggregator();
  });

  it('should register agents', () => {
    agg.register('agent1', { name: 'agent1', prompt: 'task', systemPromptMode: 'default' });
    expect(agg.getStatus()).toEqual({ agent1: 'pending' });
  });

  it('should record successful result', () => {
    agg.register('agent1', { name: 'agent1', prompt: 'task', systemPromptMode: 'default' });
    const result: SubAgentResult = {
      agentId: 'agent1',
      name: 'agent1',
      success: true,
      output: 'done',
      toolUseCount: 5,
      totalTokensUsed: 1000,
      duration: 5000,
    };
    agg.recordResult(result);
    expect(agg.getStatus().agent1).toBe('completed');
  });

  it('should record result for unregistered agent', () => {
    const result: SubAgentResult = {
      agentId: 'new-agent',
      name: 'new-agent',
      success: true,
      output: 'done',
      toolUseCount: 1,
      totalTokensUsed: 100,
      duration: 1000,
    };
    agg.recordResult(result);
    expect(agg.getStatus()['new-agent']).toBe('completed');
  });

  it('should record failure', () => {
    agg.register('agent1', { name: 'agent1', prompt: 'task', systemPromptMode: 'default' });
    agg.recordFailure('agent1', 'something broke');
    expect(agg.getStatus().agent1).toBe('failed');
  });

  it('should record failure for unregistered agent', () => {
    agg.recordFailure('unknown', 'error');
    expect(agg.getStatus().unknown).toBe('failed');
  });

  it('should record timeout', () => {
    agg.register('agent1', { name: 'agent1', prompt: 'task', systemPromptMode: 'default' });
    agg.recordTimeout('agent1', 300);
    expect(agg.getStatus().agent1).toBe('timed_out');
  });

  it('should record timeout for unregistered agent', () => {
    agg.recordTimeout('unknown', 60);
    expect(agg.getStatus().unknown).toBe('timed_out');
  });

  it('should record cancellation', () => {
    agg.register('agent1', { name: 'agent1', prompt: 'task', systemPromptMode: 'default' });
    agg.recordCancellation('agent1');
    expect(agg.getStatus().agent1).toBe('cancelled');
  });

  it('should detect all done when all completed', () => {
    agg.register('a1', { name: 'a1', prompt: '', systemPromptMode: 'default' });
    agg.register('a2', { name: 'a2', prompt: '', systemPromptMode: 'default' });
    expect(agg.isAllDone()).toBe(false);
    agg.recordResult({ agentId: 'a1', name: 'a1', success: true, output: '', toolUseCount: 0, totalTokensUsed: 0, duration: 0 });
    expect(agg.isAllDone()).toBe(false);
    agg.recordFailure('a2', 'err');
    expect(agg.isAllDone()).toBe(true);
  });

  it('should report done when empty (all done when nothing to wait for)', () => {
    expect(agg.isAllDone()).toBe(true);
  });

  it('should generate summary with results', () => {
    agg.register('a1', { name: 'agent-one', prompt: 'do something important', systemPromptMode: 'default' });
    agg.recordResult({ agentId: 'a1', name: 'agent-one', success: true, output: 'completed successfully', toolUseCount: 3, totalTokensUsed: 500, duration: 2000 });
    const summary = agg.generateSummary();
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].success).toBe(true);
    expect(summary.totalTokensUsed).toBe(500);
    expect(summary.totalToolUses).toBe(3);
    expect(summary.summary).toContain('agent-one');
    expect(summary.summary).toContain('1/1');
  });

  it('should generate summary with failed agents', () => {
    agg.register('a1', { name: 'agent1', prompt: 'task', systemPromptMode: 'default' });
    agg.recordFailure('a1', 'crashed');
    const summary = agg.generateSummary();
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].success).toBe(false);
    expect(summary.summary).toContain('0/1');
  });

  it('should generate summary for empty aggregator', () => {
    const summary = agg.generateSummary();
    expect(summary.results).toHaveLength(0);
    expect(summary.summary).toContain('No sub-agents');
  });

  it('should format timed_out result', () => {
    agg.register('a1', { name: 'agent1', prompt: 'long task', systemPromptMode: 'default' });
    agg.recordTimeout('a1', 300);
    const summary = agg.generateSummary();
    expect(summary.results[0].output).toContain('timed_out');
  });

  it('should format cancelled result', () => {
    agg.register('a1', { name: 'agent1', prompt: 'task', systemPromptMode: 'default' });
    agg.recordCancellation('a1');
    const summary = agg.generateSummary();
    expect(summary.results[0].output).toContain('cancelled');
  });

  it('should reset aggregator', () => {
    agg.register('a1', { name: 'a1', prompt: '', systemPromptMode: 'default' });
    agg.reset();
    expect(agg.getStatus()).toEqual({});
    expect(agg.isAllDone()).toBe(true);
  });

  it('should compute totalDuration as max', () => {
    agg.register('a1', { name: 'a1', prompt: '', systemPromptMode: 'default' });
    agg.register('a2', { name: 'a2', prompt: '', systemPromptMode: 'default' });
    agg.recordResult({ agentId: 'a1', name: 'a1', success: true, output: '', toolUseCount: 0, totalTokensUsed: 0, duration: 3000 });
    agg.recordResult({ agentId: 'a2', name: 'a2', success: true, output: '', toolUseCount: 0, totalTokensUsed: 0, duration: 7000 });
    const summary = agg.generateSummary();
    expect(summary.totalDuration).toBe(7000);
  });
});
