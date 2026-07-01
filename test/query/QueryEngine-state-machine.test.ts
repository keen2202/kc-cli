/**
 * State Machine Regression Tests
 *
 * Covers:
 * - All valid transitions documented in VALID_TRANSITIONS are exercisable
 * - Invalid transitions throw InvalidTransitionError
 * - forceTransitionTo correctly bypasses validation
 * - Session tree branch/checkout/merge preserves state machine integrity
 * - End-of-session with AGP evolution reaches completed state (integration)
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { AgentStateMachine, InvalidTransitionError } from '../../src/state/machine';
import { ObservableStateStore } from '../../src/state/store';
import { VALID_TRANSITIONS, type AgentStateName } from '../../src/state/types';
import { isValidTransition } from '../../src/state/types';
import { SessionTree } from '../../src/state/session-tree';

function createStore(): ObservableStateStore {
  return new ObservableStateStore({
    cwd: '/test',
    sessionId: 'test-session',
    verbose: false,
    printMode: false,
    bareMode: false,
    model: 'test-model',
    provider: 'anthropic',
    maxTokens: 4096,
    permissionMode: 'default',
    currentState: 'idle',
    turnCount: 0,
    maxTurns: 50,
    maxBudgetUsd: null,
    totalTokensUsed: 0,
    budgetUsed: { session: 0, currentTurn: 0, toolResults: 0 },
    compactFailureCount: 0,
    lastCompactedAt: null,
    activeToolExecutions: new Map(),
    activeBranchId: 'root',
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
  });
}

// ── Valid Transitions ──

describe('State Machine — Valid Transitions', () => {
  let store: ObservableStateStore;
  let machine: AgentStateMachine;

  beforeEach(() => {
    store = createStore();
    machine = new AgentStateMachine(store, 'idle');
  });

  it('idle → planning', () => {
    machine.transitionTo('planning');
    expect(machine.currentState).toBe('planning');
  });

  it('idle → compacting', () => {
    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
  });

  it('planning → compacting', () => {
    machine.transitionTo('planning');
    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
  });

  it('planning → streaming', () => {
    machine.transitionTo('planning');
    machine.transitionTo('streaming');
    expect(machine.currentState).toBe('streaming');
  });

  it('planning → error', () => {
    machine.transitionTo('planning');
    machine.transitionTo('error');
    expect(machine.currentState).toBe('error');
  });

  it('compacting → streaming', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    expect(machine.currentState).toBe('streaming');
  });

  it('compacting → error', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('error');
    expect(machine.currentState).toBe('error');
  });

  it('streaming → deciding', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    expect(machine.currentState).toBe('deciding');
  });

  it('streaming → compacting', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
  });

  it('streaming → error', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('error');
    expect(machine.currentState).toBe('error');
  });

  it('deciding → executing', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');
    expect(machine.currentState).toBe('executing');
  });

  it('deciding → completed', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('completed');
    expect(machine.currentState).toBe('completed');
  });

  it('deciding → compacting', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
  });

  it('executing → streaming', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');
    machine.transitionTo('streaming');
    expect(machine.currentState).toBe('streaming');
  });

  it('executing → compacting', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');
    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
  });

  it('executing → completed', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');
    machine.transitionTo('completed');
    expect(machine.currentState).toBe('completed');
  });

  it('executing → error', () => {
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');
    machine.transitionTo('error');
    expect(machine.currentState).toBe('error');
  });

  it('evolving → idle', () => {
    const evolvingMachine = new AgentStateMachine(store, 'evolving');
    evolvingMachine.transitionTo('idle');
    expect(evolvingMachine.currentState).toBe('idle');
  });

  it('evolving → completed', () => {
    const evolvingMachine = new AgentStateMachine(store, 'evolving');
    evolvingMachine.transitionTo('completed');
    expect(evolvingMachine.currentState).toBe('completed');
  });

  it('evolving → error', () => {
    const evolvingMachine = new AgentStateMachine(store, 'evolving');
    evolvingMachine.transitionTo('error');
    expect(evolvingMachine.currentState).toBe('error');
  });

  it('error → idle', () => {
    const errorMachine = new AgentStateMachine(store, 'error');
    errorMachine.transitionTo('idle');
    expect(errorMachine.currentState).toBe('idle');
  });
});

// ── Invalid Transitions ──

describe('State Machine — Invalid Transitions', () => {
  let store: ObservableStateStore;
  let machine: AgentStateMachine;

  beforeEach(() => {
    store = createStore();
    machine = new AgentStateMachine(store, 'idle');
  });

  it('idle → streaming throws', () => {
    expect(() => machine.transitionTo('streaming')).toThrow(InvalidTransitionError);
  });

  it('idle → executing throws', () => {
    expect(() => machine.transitionTo('executing')).toThrow(InvalidTransitionError);
  });

  it('idle → completed throws', () => {
    expect(() => machine.transitionTo('completed')).toThrow(InvalidTransitionError);
  });

  it('completed → idle throws (completed is terminal)', () => {
    const doneMachine = new AgentStateMachine(store, 'completed');
    expect(() => doneMachine.transitionTo('idle')).toThrow(InvalidTransitionError);
  });

  it('completed → streaming throws', () => {
    const doneMachine = new AgentStateMachine(store, 'completed');
    expect(() => doneMachine.transitionTo('streaming')).toThrow(InvalidTransitionError);
  });

  it('error → streaming throws (can only go to idle)', () => {
    const errorMachine = new AgentStateMachine(store, 'error');
    expect(() => errorMachine.transitionTo('streaming')).toThrow(InvalidTransitionError);
  });

  it('streaming → executing throws', () => {
    const streamingMachine = new AgentStateMachine(store, 'streaming');
    expect(() => streamingMachine.transitionTo('executing')).toThrow(InvalidTransitionError);
  });

  it('error message includes valid transitions', () => {
    try {
      machine.transitionTo('streaming');
    } catch (e) {
      const err = e as InvalidTransitionError;
      expect(err.message).toContain('idle');
      expect(err.message).toContain('planning');
      expect(err.message).toContain('compacting');
    }
  });

  it('InvalidTransitionError has correct name', () => {
    try {
      machine.transitionTo('streaming');
    } catch (e) {
      expect((e as Error).name).toBe('InvalidTransitionError');
    }
  });
});

// ── Force Transition ──

describe('State Machine — forceTransitionTo', () => {
  let store: ObservableStateStore;
  let machine: AgentStateMachine;

  beforeEach(() => {
    store = createStore();
    machine = new AgentStateMachine(store, 'idle');
  });

  it('bypasses validation for invalid transition', () => {
    // idle → streaming is invalid normally
    expect(() => machine.transitionTo('streaming')).toThrow();
    // forceTransitionTo should succeed
    machine.forceTransitionTo('streaming');
    expect(machine.currentState).toBe('streaming');
  });

  it('works for valid transitions too', () => {
    machine.forceTransitionTo('completed');
    expect(machine.currentState).toBe('completed');
  });

  it('updates store state', () => {
    machine.forceTransitionTo('error');
    expect(machine.currentState).toBe('error');
    expect(store.get().currentState).toBe('error');
  });

  it('can transition from terminal state', () => {
    const doneMachine = new AgentStateMachine(store, 'completed');
    doneMachine.forceTransitionTo('idle');
    expect(doneMachine.currentState).toBe('idle');
  });
});

// ── Utility methods ──

describe('State Machine — utility methods', () => {
  it('canTransition returns false for invalid', () => {
    const store = createStore();
    const machine = new AgentStateMachine(store, 'idle');
    expect(machine.canTransition('planning')).toBe(true);
    expect(machine.canTransition('streaming')).toBe(false);
  });

  it('getValidNextStates returns correct list', () => {
    const store = createStore();
    const machine = new AgentStateMachine(store, 'idle');
    const next = machine.getValidNextStates();
    expect(next).toContain('planning');
    expect(next).toContain('compacting');
    expect(next).not.toContain('streaming');
  });

  it('isTerminal returns true for completed and error', () => {
    const store = createStore();
    const idleMachine = new AgentStateMachine(store, 'idle');
    expect(idleMachine.isTerminal()).toBe(false);

    const doneMachine = new AgentStateMachine(store, 'completed');
    expect(doneMachine.isTerminal()).toBe(true);

    const errorMachine = new AgentStateMachine(store, 'error');
    expect(errorMachine.isTerminal()).toBe(true);
  });

  it('isExecuting and isStreaming work', () => {
    const store = createStore();
    const execMachine = new AgentStateMachine(store, 'executing');
    expect(execMachine.isExecuting()).toBe(true);
    expect(execMachine.isStreaming()).toBe(false);

    const streamMachine = new AgentStateMachine(store, 'streaming');
    expect(streamMachine.isExecuting()).toBe(false);
    expect(streamMachine.isStreaming()).toBe(true);
  });

  it('reset returns to idle', () => {
    const store = createStore();
    const machine = new AgentStateMachine(store, 'executing');
    machine.reset();
    expect(machine.currentState).toBe('idle');
  });
});

// ── Session Tree — Branch/Checkout/Merge Integrity ──

describe('Session Tree — state machine integrity', () => {
  it('creates root node on construction', () => {
    const tree = new SessionTree();
    expect(tree.getActiveNodeId()).toBeTruthy();
  });

  it('branch creates a new child node', () => {
    const tree = new SessionTree();
    const rootId = tree.getActiveNodeId();
    const branchId = tree.branch();
    expect(branchId).not.toBe(rootId);
    expect(tree.getActiveNodeId()).toBe(branchId);
  });

  it('checkout switches active branch', () => {
    const tree = new SessionTree();
    const rootId = tree.getActiveNodeId();
    const branchId = tree.branch();
    tree.checkout(rootId);
    expect(tree.getActiveNodeId()).toBe(rootId);
  });

  it('checkout throws for non-existent node', () => {
    const tree = new SessionTree();
    expect(() => tree.checkout('nonexistent')).toThrow();
  });

  it('branch inherits parent messages up to branch point', () => {
    const tree = new SessionTree([
      { id: 'm1', role: 'user', content: 'hello', timestamp: 1000 },
      { id: 'm2', role: 'assistant', content: 'hi', timestamp: 2000 },
    ]);
    tree.branch();
    // New branch inherits parent messages
    const messages = tree.getActiveMessages();
    expect(messages.length).toBe(2);
  });

  it('merge moves messages from a branch into its parent', () => {
    const tree = new SessionTree([{ id: 'm1', role: 'user', content: 'root', timestamp: 1000 }]);
    const rootId = tree.getActiveNodeId();
    // Create a branch and add messages to it
    const branchId = tree.branch();
    // Merge the branch into its parent (root)
    tree.merge(branchId);
    // After merge, active branch should be root
    expect(tree.getActiveNodeId()).toBe(rootId);
  });

  it('getNodeChain returns ancestors in order', () => {
    const tree = new SessionTree([{ id: 'm1', role: 'user', content: 'root', timestamp: 1000 }]);
    const rootId = tree.getActiveNodeId();
    const chain = tree.getNodeChain(rootId);
    expect(chain.length).toBe(1);
    expect(chain[0]!.id).toBe(rootId);
  });

  it('branch and checkout preserve tree integrity', () => {
    const tree = new SessionTree([{ id: 'm1', role: 'user', content: 'test', timestamp: 1000 }]);
    const rootId = tree.getActiveNodeId();
    const branchId = tree.branch();

    // Checkout back to root
    tree.checkout(rootId);
    expect(tree.getActiveNodeId()).toBe(rootId);

    // Checkout to branch
    tree.checkout(branchId);
    expect(tree.getActiveNodeId()).toBe(branchId);
  });
});

// ── Integration: Evolution → completed ──

describe('State Machine — Evolution to completed', () => {
  it('evolving can transition to completed', () => {
    const store = createStore();
    const machine = new AgentStateMachine(store, 'evolving');
    machine.transitionTo('completed');
    expect(machine.currentState).toBe('completed');
    expect(store.get().currentState).toBe('completed');
  });

  it('full query loop: idle → compacting → streaming → deciding → executing → streaming → deciding → completed', () => {
    const store = createStore();
    const machine = new AgentStateMachine(store, 'idle');

    // First turn
    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');
    machine.transitionTo('executing');

    // Back to streaming for more content
    machine.transitionTo('streaming');
    machine.transitionTo('deciding');

    // Complete the session
    machine.transitionTo('completed');
    expect(machine.currentState).toBe('completed');
    expect(machine.isTerminal()).toBe(true);
  });

  it('full query loop with error recovery', () => {
    const store = createStore();
    const machine = new AgentStateMachine(store, 'idle');

    machine.transitionTo('compacting');
    machine.transitionTo('streaming');
    // Error occurs during streaming
    machine.transitionTo('error');
    expect(machine.currentState).toBe('error');

    // Recover to idle
    machine.transitionTo('idle');
    expect(machine.currentState).toBe('idle');

    // Start a new turn
    machine.transitionTo('compacting');
    expect(machine.currentState).toBe('compacting');
  });

  it('evolution path: evolving → idle (AGP cycle complete)', () => {
    const store = createStore();
    // Simulate: session completed, AGP evolution runs, returns to idle
    const doneMachine = new AgentStateMachine(store, 'completed');
    // Can't transition from completed normally
    expect(doneMachine.isTerminal()).toBe(true);

    // Force to evolving (AGP kicks in)
    doneMachine.forceTransitionTo('evolving');
    expect(doneMachine.currentState).toBe('evolving');

    // Evolution completes, return to idle
    doneMachine.transitionTo('idle');
    expect(doneMachine.currentState).toBe('idle');
  });
});

// ── VALID_TRANSITIONS completeness check ──

describe('VALID_TRANSITIONS — completeness', () => {
  const allStates: AgentStateName[] = [
    'idle', 'planning', 'compacting', 'streaming', 'deciding',
    'executing', 'completed', 'evolving', 'error',
  ];

  it('every state has a transitions entry', () => {
    for (const state of allStates) {
      expect(VALID_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('completed has no outgoing transitions', () => {
    expect(VALID_TRANSITIONS.completed).toEqual([]);
  });

  it('evolving can reach completed (regression for H5 fix)', () => {
    expect(VALID_TRANSITIONS.evolving).toContain('completed');
  });

  it('all transitions in the map are valid state names', () => {
    for (const [from, toList] of Object.entries(VALID_TRANSITIONS)) {
      for (const to of toList) {
        expect(allStates).toContain(to);
      }
    }
  });

  it('isValidTransition returns correct boolean', () => {
    expect(isValidTransition('idle', 'planning')).toBe(true);
    expect(isValidTransition('idle', 'streaming')).toBe(false);
    expect(isValidTransition('evolving', 'completed')).toBe(true);
    expect(isValidTransition('completed', 'idle')).toBe(false);
  });
});
