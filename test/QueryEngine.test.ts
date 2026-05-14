// QueryEngine Tests - Comprehensive Coverage
// Covers: state machine loop, compaction, streaming, tool execution,
// error handling, retry, abort, message trimming, memory integration

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toolRegistry, registerBuiltInTools } from '../src/tools.js';
import { initializeState } from '../src/bootstrap/state.js';

beforeEach(() => {
  initializeState();
  process.env.KC_API_KEY = 'test-dummy-key';
});

// ── QueryEngine Construction ──

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

  it('should return empty messages initially', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    expect(engine.getMessages()).toEqual([]);
  });

  it('should expose memory integration', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    expect(engine.getMemoryIntegration()).toBeDefined();
  });

  it('should support abort signal', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    expect(engine.isAborted()).toBe(false);
    engine.abort('test abort');
    expect(engine.isAborted()).toBe(true);
  });

  it('should accept custom system prompt', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
      systemPrompt: 'You are a test assistant.',
    }, tools);

    expect(engine.getStateMachine()).toBeDefined();
  });

  it('should accept custom context window', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
      contextWindow: 100_000,
    }, tools);

    expect(engine.getStateMachine()).toBeDefined();
  });

  it('should accept max messages config', async () => {
    const { QueryEngine } = await import('../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
      maxMessages: 500,
    }, tools);

    expect(engine.getMessages()).toEqual([]);
  });
});

// ── State Machine Transitions ──

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
    const { AgentStateMachine } = await import('../src/state/machine.js');
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

  it('should support error as terminal state', async () => {
    const { AgentStateMachine } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');
    machine.forceTransitionTo('error');

    expect(machine.isTerminal()).toBe(true);
    expect(machine.currentState).toBe('error');
  });

  it('should follow full lifecycle: idle→compact→stream→decide→complete', async () => {
    const { AgentStateMachine } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    expect(machine.currentState).toBe('idle');

    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');

    machine.transitionTo('streaming');
    expect(machine.currentState).toBe('streaming');

    machine.transitionTo('deciding');
    expect(machine.currentState).toBe('deciding');

    // No tool calls → completed
    machine.transitionTo('completed');
    expect(machine.currentState).toBe('completed');
    expect(machine.isTerminal()).toBe(true);
  });

  it('should follow tool loop: idle→compact→stream→decide→execute→stream→decide→complete', async () => {
    const { AgentStateMachine } = await import('../src/state/machine.js');
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const machine = new AgentStateMachine(store);

    // First loop: with tool calls
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');

    // Loop back to streaming
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');

    // No more tools → complete
    machine.transitionTo('completed');

    expect(machine.isTerminal()).toBe(true);
  });
});

// ── ObservableStateStore ──

describe('ObservableStateStore', () => {
  it('should track turn count', async () => {
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    expect(store.get().turnCount).toBe(0);

    store.incrementTurn();
    expect(store.get().turnCount).toBe(1);

    store.incrementTurn();
    expect(store.get().turnCount).toBe(2);
  });

  it('should track total tokens used', async () => {
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    expect(store.get().totalTokensUsed).toBe(0);
  });

  it('should emit state change events', async () => {
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const changes: any[] = [];

    store.subscribe((state) => {
      changes.push(state);
    });

    store.incrementTurn();

    expect(changes.length).toBe(1);
  });

  it('should support unsubscribe', async () => {
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const changes: any[] = [];

    const unsubscribe = store.subscribe((state) => {
      changes.push(state);
    });

    store.incrementTurn();
    unsubscribe();
    store.incrementTurn();

    expect(changes.length).toBe(1);
  });
});

// ── Token Estimation ──

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

  it('should estimate tokens for message arrays', async () => {
    const { estimateMessageTokensArray } = await import('../src/utils/tokenEstimation.js');

    const messages = [
      { id: '1', role: 'user' as const, content: 'Hello', timestamp: Date.now() },
      { id: '2', role: 'assistant' as const, content: 'Hi there!', timestamp: Date.now() },
    ];

    const tokens = estimateMessageTokensArray(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should handle empty message array', async () => {
    const { estimateMessageTokensArray } = await import('../src/utils/tokenEstimation.js');

    const tokens = estimateMessageTokensArray([]);
    expect(tokens).toBe(0);
  });

  it('should handle messages with tool calls', async () => {
    const { estimateMessageTokensArray } = await import('../src/utils/tokenEstimation.js');

    const messages = [
      {
        id: '1',
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
        toolCalls: [{
          id: 'tc1',
          toolName: 'Bash',
          input: { command: 'ls -la' },
        }],
      },
    ];

    const tokens = estimateMessageTokensArray(messages);
    expect(tokens).toBeGreaterThan(0);
  });

  it('should provide tiktoken-based estimation via TokenCounter', async () => {
    const { TokenCounter } = await import('../src/utils/tokenEstimation.js');

    const counter = new TokenCounter('openai', 'gpt-4');
    const tokens = counter.count('Hello, world!');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });
});

// ── Compaction Service ──

describe('Compaction Service', () => {
  it('should not compact few messages', async () => {
    const { microcompact } = await import('../src/services/compaction.js');

    const messages = [
      { id: '1', role: 'user' as const, content: 'Hello', timestamp: Date.now() },
      { id: '2', role: 'assistant' as const, content: 'Hi', timestamp: Date.now() },
    ];

    const result = microcompact(messages, 5);
    expect(result.wasCompacted).toBe(false);
  });

  it('should compact many messages with tool results', async () => {
    const { microcompact } = await import('../src/services/compaction.js');

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

  it('should report tokens saved', async () => {
    const { microcompact } = await import('../src/services/compaction.js');

    const messages: any[] = [];
    for (let i = 0; i < 15; i++) {
      messages.push(
        { id: `user_${i}`, role: 'user', content: `Question ${i}`, timestamp: Date.now() },
        {
          id: `assistant_${i}`, role: 'assistant', content: '',
          timestamp: Date.now(),
          toolCalls: [{ id: `tc_${i}`, toolName: 'Bash', input: { command: 'echo' } }],
        },
        {
          id: `tool_${i}`, role: 'tool', content: '',
          timestamp: Date.now(),
          toolResults: [{ toolCallId: `tc_${i}`, output: 'y'.repeat(300), isError: false }],
        },
      );
    }

    const result = microcompact(messages, 5);
    if (result.wasCompacted) {
      expect(result.tokensSaved).toBeGreaterThan(0);
    }
  });

  it('should preserve user messages during compaction', async () => {
    const { microcompact } = await import('../src/services/compaction.js');

    const messages: any[] = [];
    for (let i = 0; i < 10; i++) {
      messages.push(
        { id: `user_${i}`, role: 'user', content: `Message ${i}`, timestamp: Date.now() },
        {
          id: `assistant_${i}`, role: 'assistant', content: '',
          timestamp: Date.now(),
          toolCalls: [{ id: `tc_${i}`, toolName: 'Bash', input: { command: 'ls' } }],
        },
        {
          id: `tool_${i}`, role: 'tool', content: '',
          timestamp: Date.now(),
          toolResults: [{ toolCallId: `tc_${i}`, output: 'z'.repeat(200), isError: false }],
        },
      );
    }

    const result = microcompact(messages, 5);
    if (result.wasCompacted) {
      // User messages should still be present
      const userMessages = result.messages.filter((m: any) => m.role === 'user');
      expect(userMessages.length).toBeGreaterThan(0);
    }
  });

  it('should handle compaction with keepRecent parameter', async () => {
    const { microcompact } = await import('../src/services/compaction.js');

    const messages: any[] = [];
    for (let i = 0; i < 20; i++) {
      messages.push(
        { id: `user_${i}`, role: 'user', content: `Test ${i}`, timestamp: Date.now() },
        {
          id: `assistant_${i}`, role: 'assistant', content: '',
          timestamp: Date.now(),
          toolCalls: [{ id: `tc_${i}`, toolName: 'Bash', input: { command: 'echo' } }],
        },
        {
          id: `tool_${i}`, role: 'tool', content: '',
          timestamp: Date.now(),
          toolResults: [{ toolCallId: `tc_${i}`, output: 'x'.repeat(200), isError: false }],
        },
      );
    }

    // keepRecent=5 means keep only 5 most recent messages (+2 buffer)
    const result = microcompact(messages, 5);
    expect(result.wasCompacted).toBe(true);
  });
});

// ── Error Classifier ──

describe('Error Classifier', () => {
  it('should classify rate limit errors as retryable', async () => {
    const { classifyApiError } = await import('../src/services/error-classifier.js');

    const error = new Error('rate limit exceeded');
    const classified = classifyApiError(error);
    expect(classified.retryable).toBe(true);
  });

  it('should classify network errors as retryable', async () => {
    const { classifyApiError } = await import('../src/services/error-classifier.js');

    const error = new Error('ECONNRESET');
    const classified = classifyApiError(error);
    expect(classified.retryable).toBe(true);
  });

  it('should classify auth errors as non-retryable', async () => {
    const { classifyApiError } = await import('../src/services/error-classifier.js');

    const error = new Error('401 unauthorized');
    const classified = classifyApiError(error);
    expect(classified.retryable).toBe(false);
  });

  it('should provide retry delay', async () => {
    const { getRetryDelay } = await import('../src/services/error-classifier.js');

    const delay1 = getRetryDelay(0);
    const delay2 = getRetryDelay(1);
    const delay3 = getRetryDelay(2);

    // Exponential backoff
    expect(delay2).toBeGreaterThan(delay1);
    expect(delay3).toBeGreaterThan(delay2);
  });

  it('should track retry state', async () => {
    const { RetryState } = await import('../src/services/error-classifier.js');

    const state = new RetryState();
    expect(state.canRetry('streaming')).toBe(true);

    state.incrementAttempt('streaming');
    expect(state.canRetry('streaming')).toBe(true);

    // After max retries
    state.incrementAttempt('streaming');
    state.incrementAttempt('streaming');
    expect(state.canRetry('streaming')).toBe(false);

    state.reset('streaming');
    expect(state.canRetry('streaming')).toBe(true);
  });
});

// ── State Store Integration ──

describe('State Store Integration', () => {
  it('should track conversation state across operations', async () => {
    const { ObservableStateStore, createInitialState } = await import('../src/state/store.js');

    const store = new ObservableStateStore(createInitialState());
    const state = store.get();

    expect(state.turnCount).toBe(0);
    expect(state.totalTokensUsed).toBe(0);
  });

  it('should provide initial state with defaults', async () => {
    const { createInitialState } = await import('../src/state/store.js');

    const state = createInitialState();
    expect(state.turnCount).toBe(0);
    expect(state.totalTokensUsed).toBe(0);
    expect(state.maxTurns).toBe(50);
  });

  it('should accept initial config overrides', async () => {
    const { createInitialState } = await import('../src/state/store.js');

    const state = createInitialState({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 50,
      maxBudgetUsd: 10,
    });

    expect(state.model).toBe('gpt-4');
    expect(state.provider).toBe('openai');
  });
});
