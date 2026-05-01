// QueryEngine Tests

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolRegistry, registerBuiltInTools } from '../src/tools.js';
import { initializeState } from '../src/bootstrap/state.js';

beforeEach(() => {
  initializeState();
  process.env.KC_API_KEY = 'test-dummy-key';
});

describe('QueryEngine', () => {
  it('should be creatable with tools', async () => {
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();
    expect(tools.length).toBeGreaterThan(0);
  });

  it('should have state machine', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    const stateMachine = engine.getStateMachine();
    expect(stateMachine).toBeDefined();
    expect(stateMachine.currentState).toBe('idle');
  });

  it('should have state store', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    const stateStore = engine.getStateStore();
    expect(stateStore).toBeDefined();
  });

  it('should clear conversation', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    engine.clear();
    const stateMachine = engine.getStateMachine();
    expect(stateMachine.currentState).toBe('idle');
  });
});

describe('State Machine', () => {
  it('should start in idle state', async () => {
    const { AgentStateMachine } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    expect(machine.currentState).toBe('idle');
  });

  it('should transition from idle to compacting', async () => {
    const { AgentStateMachine } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
  });

  it('should validate transitions', async () => {
    const { AgentStateMachine, InvalidTransitionError } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    // Valid transition
    expect(machine.canTransition('compacting')).toBe(true);

    // Invalid transition
    expect(machine.canTransition('streaming')).toBe(false);
  });

  it('should throw on invalid transition', async () => {
    const { AgentStateMachine, InvalidTransitionError } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    try {
      machine.transitionTo('streaming');
      expect(false).toBe(true); // Should not reach here
    } catch (error) {
      expect(error instanceof InvalidTransitionError).toBe(true);
    }
  });

  it('should detect terminal states', async () => {
    const { AgentStateMachine } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    expect(machine.isTerminal()).toBe(false);

    // Transition to completed
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('completed');

    expect(machine.isTerminal()).toBe(true);
  });

  it('should reset to idle', async () => {
    const { AgentStateMachine } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');

    machine.reset();
    expect(machine.currentState).toBe('idle');
  });
});

describe('Token Estimation', () => {
  it('should estimate tokens for short text', async () => {
    const { estimateTokens } = await import('../src/utils/tokenEstimation.js');

    const tokens = estimateTokens('Hello, world!');
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle empty string', async () => {
    const { estimateTokens } = await import('../src/utils/tokenEstimation.js');

    const tokens = estimateTokens('');
    expect(tokens).toBe(0);
  });

  it('should scale with text length', async () => {
    const { estimateTokens } = await import('../src/utils/tokenEstimation.js');

    const shortTokens = estimateTokens('Hello');
    const longTokens = estimateTokens('Hello world, this is a longer test message with more words');

    expect(longTokens).toBeGreaterThan(shortTokens);
  });
});

describe('Compaction Service', () => {
  it('should not compact few messages', async () => {
    const { microcompact } = await import('../src/services/compaction.js');

    const messages = [
      { id: '1', role: 'user', content: 'Hello', timestamp: Date.now() },
      { id: '2', role: 'assistant', content: 'Hi', timestamp: Date.now() },
    ];

    const result = microcompact(messages, 5);
    expect(result.wasCompacted).toBe(false);
  });

  it('should compact many messages', async () => {
    const { microcompact } = await import('../src/services/compaction.js');

    // Create messages with tool calls and tool results
    const messages: any[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(
        { id: `user_${i}`, role: 'user', content: `Request ${i}`, timestamp: Date.now() },
        {
          id: `assistant_${i}`, role: 'assistant', content: '',
          timestamp: Date.now(),
          toolCalls: [{ id: `tc_${i}`, toolName: 'Bash', input: { command: 'ls' } }],
        },
        {
          id: `tool_${i}`, role: 'tool', content: '',
          timestamp: Date.now(),
          toolResults: [{ toolCallId: `tc_${i}`, output: 'x'.repeat(200), isError: false }],
        },
      );
    }

    const result = microcompact(messages, 5);
    expect(result.wasCompacted).toBe(true);
  });
});
