import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObservableStateStore, createInitialState } from '../../src/state/store';
import type { AgentState, ToolExecutionState } from '../../src/state/types';

/** Helper to create a minimal ToolExecutionState */
function makeToolExec(
  overrides: Partial<ToolExecutionState> = {},
): ToolExecutionState {
  return {
    id: 'tool-1',
    toolCall: { id: 'tc-1', name: 'bash', arguments: '{}' } as any,
    status: 'pending',
    ...overrides,
  };
}

describe('ObservableStateStore - updateToolExecution', () => {
  let store: ObservableStateStore;

  beforeEach(() => {
    store = new ObservableStateStore(createInitialState());
  });

  it('should add a new tool execution', () => {
    const exec = makeToolExec({ id: 'tool-abc' });
    store.updateToolExecution('tool-abc', exec);
    const tools = store.get().activeToolExecutions;
    expect(tools.size).toBe(1);
    expect(tools.get('tool-abc')).toEqual(expect.objectContaining({ id: 'tool-abc', status: 'pending' }));
  });

  it('should update an existing tool execution (merge fields)', () => {
    store.updateToolExecution('tool-1', makeToolExec({ id: 'tool-1', status: 'pending' }));
    store.updateToolExecution('tool-1', { status: 'running', startedAt: 1000 });
    const tool = store.get().activeToolExecutions.get('tool-1');
    expect(tool).toEqual(
      expect.objectContaining({ id: 'tool-1', status: 'running', startedAt: 1000 }),
    );
  });

  it('should transition a tool through its full lifecycle', () => {
    const id = 'lifecycle-tool';
    store.updateToolExecution(id, makeToolExec({ id, status: 'pending' }));
    store.updateToolExecution(id, { status: 'running', startedAt: Date.now() });
    store.updateToolExecution(id, { status: 'completed', completedAt: Date.now() });
    expect(store.get().activeToolExecutions.get(id)!.status).toBe('completed');
  });

  it('should track multiple independent tool executions', () => {
    store.updateToolExecution('a', makeToolExec({ id: 'a', status: 'pending' }));
    store.updateToolExecution('b', makeToolExec({ id: 'b', status: 'running' }));
    store.updateToolExecution('c', makeToolExec({ id: 'c', status: 'completed' }));
    const tools = store.get().activeToolExecutions;
    expect(tools.size).toBe(3);
    expect(tools.get('a')!.status).toBe('pending');
    expect(tools.get('b')!.status).toBe('running');
    expect(tools.get('c')!.status).toBe('completed');
  });
});

describe('ObservableStateStore - cleanupOldToolExecutions', () => {
  it('should clean up old completed executions when limit is exceeded', () => {
    const store = new ObservableStateStore(createInitialState());
    const now = Date.now();
    const oldTime = now - 10 * 60 * 1000; // 10 minutes ago (well past the 5-min threshold)

    // Fill up to the limit with old completed executions
    for (let i = 0; i < 501; i++) {
      store.updateToolExecution(`old-${i}`, {
        id: `old-${i}`,
        toolCall: { id: `tc-old-${i}`, name: 'bash', arguments: '{}' } as any,
        status: i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'failed' : 'killed',
        completedAt: oldTime,
      } as ToolExecutionState);
    }

    // The cleanup should have kicked in, removing old completed/failed/killed entries
    const tools = store.get().activeToolExecutions;
    expect(tools.size).toBeLessThanOrEqual(500);
  });

  it('should remove any completed entries if still over limit after age-based cleanup', () => {
    const store = new ObservableStateStore(createInitialState());
    const now = Date.now();

    // Fill with 499 running (non-removable) executions
    for (let i = 0; i < 499; i++) {
      store.updateToolExecution(`running-${i}`, {
        id: `running-${i}`,
        toolCall: { id: `tc-r-${i}`, name: 'bash', arguments: '{}' } as any,
        status: 'running',
      } as ToolExecutionState);
    }

    // Now add enough recent completed executions to push past 500
    // These won't be caught by age-based cleanup (completedAt is recent)
    for (let i = 0; i < 10; i++) {
      store.updateToolExecution(`recent-done-${i}`, {
        id: `recent-done-${i}`,
        toolCall: { id: `tc-rd-${i}`, name: 'bash', arguments: '{}' } as any,
        status: 'completed',
        completedAt: now, // Recent - won't match age threshold
      } as ToolExecutionState);
    }

    // Should still be capped at 500
    expect(store.get().activeToolExecutions.size).toBeLessThanOrEqual(500);
  });

  it('should not remove running or pending executions during cleanup', () => {
    const store = new ObservableStateStore(createInitialState());
    const now = Date.now();
    const oldTime = now - 10 * 60 * 1000;

    // Add 499 running executions
    for (let i = 0; i < 499; i++) {
      store.updateToolExecution(`run-${i}`, {
        id: `run-${i}`,
        toolCall: { id: `tc-run-${i}`, name: 'bash', arguments: '{}' } as any,
        status: 'running',
      } as ToolExecutionState);
    }

    // Add 5 old completed to exceed limit
    for (let i = 0; i < 5; i++) {
      store.updateToolExecution(`done-${i}`, {
        id: `done-${i}`,
        toolCall: { id: `tc-done-${i}`, name: 'bash', arguments: '{}' } as any,
        status: 'completed',
        completedAt: oldTime,
      } as ToolExecutionState);
    }

    const tools = store.get().activeToolExecutions;
    // Running ones should survive; old completed ones should be cleaned up
    expect(tools.size).toBeLessThanOrEqual(500);

    // Verify running executions survived
    for (let i = 0; i < 100; i++) {
      expect(tools.has(`run-${i}`)).toBe(true);
    }
  });
});

describe('ObservableStateStore - removeToolExecution', () => {
  let store: ObservableStateStore;

  beforeEach(() => {
    store = new ObservableStateStore(createInitialState());
  });

  it('should remove an existing tool execution', () => {
    store.updateToolExecution('tool-1', makeToolExec());
    expect(store.get().activeToolExecutions.size).toBe(1);
    store.removeToolExecution('tool-1');
    expect(store.get().activeToolExecutions.size).toBe(0);
    expect(store.get().activeToolExecutions.has('tool-1')).toBe(false);
  });

  it('should be a no-op when removing a non-existent tool execution', () => {
    store.updateToolExecution('tool-1', makeToolExec());
    store.removeToolExecution('nonexistent');
    expect(store.get().activeToolExecutions.size).toBe(1);
  });

  it('should not affect other tool executions when removing one', () => {
    store.updateToolExecution('a', makeToolExec({ id: 'a' }));
    store.updateToolExecution('b', makeToolExec({ id: 'b' }));
    store.removeToolExecution('a');
    expect(store.get().activeToolExecutions.size).toBe(1);
    expect(store.get().activeToolExecutions.has('b')).toBe(true);
  });
});

describe('ObservableStateStore - lastActivityAt', () => {
  it('should update lastActivityAt on every set() call', () => {
    const store = new ObservableStateStore(createInitialState());
    const initialActivity = store.get().lastActivityAt;

    // Advance time by faking Date.now
    const later = initialActivity + 5000;
    vi.spyOn(Date, 'now').mockReturnValue(later);

    store.set({ turnCount: 1 });
    expect(store.get().lastActivityAt).toBe(later);

    vi.restoreAllMocks();
  });

  it('should update lastActivityAt via incrementTurn', () => {
    const store = new ObservableStateStore(createInitialState());
    const initialActivity = store.get().lastActivityAt;

    const later = initialActivity + 10000;
    vi.spyOn(Date, 'now').mockReturnValue(later);

    store.incrementTurn();
    expect(store.get().lastActivityAt).toBe(later);

    vi.restoreAllMocks();
  });

  it('should update lastActivityAt via addTokenUsage', () => {
    const store = new ObservableStateStore(createInitialState());
    const initialActivity = store.get().lastActivityAt;

    const later = initialActivity + 20000;
    vi.spyOn(Date, 'now').mockReturnValue(later);

    store.addTokenUsage(50);
    expect(store.get().lastActivityAt).toBe(later);

    vi.restoreAllMocks();
  });

  it('should update lastActivityAt via updateField', () => {
    const store = new ObservableStateStore(createInitialState());
    const later = store.get().lastActivityAt + 30000;
    vi.spyOn(Date, 'now').mockReturnValue(later);

    store.updateField('verbose', true);
    expect(store.get().lastActivityAt).toBe(later);

    vi.restoreAllMocks();
  });

  it('should update lastActivityAt via resetToIdle', () => {
    const store = new ObservableStateStore(createInitialState());
    store.set({ currentState: 'streaming' });
    const later = store.get().lastActivityAt + 15000;
    vi.spyOn(Date, 'now').mockReturnValue(later);

    store.resetToIdle();
    expect(store.get().lastActivityAt).toBe(later);

    vi.restoreAllMocks();
  });
});

describe('ObservableStateStore - state transitions', () => {
  let store: ObservableStateStore;

  beforeEach(() => {
    store = new ObservableStateStore(createInitialState());
  });

  it('should transition through idle -> compacting -> streaming -> deciding -> executing -> completed', () => {
    expect(store.get().currentState).toBe('idle');

    store.set({ currentState: 'compacting' });
    expect(store.get().currentState).toBe('compacting');

    store.set({ currentState: 'streaming' });
    expect(store.get().currentState).toBe('streaming');

    store.set({ currentState: 'deciding' });
    expect(store.get().currentState).toBe('deciding');

    store.set({ currentState: 'executing' });
    expect(store.get().currentState).toBe('executing');

    store.set({ currentState: 'completed' });
    expect(store.get().currentState).toBe('completed');
  });

  it('should transition to error from any state', () => {
    const states = ['idle', 'compacting', 'streaming', 'deciding', 'executing', 'completed'] as const;
    for (const state of states) {
      store.resetToIdle();
      store.set({ currentState: state });
      store.set({ currentState: 'error' });
      expect(store.get().currentState).toBe('error');
    }
  });

  it('should reset from any state back to idle via resetToIdle', () => {
    const states = ['compacting', 'streaming', 'deciding', 'executing', 'completed', 'error'] as const;
    for (const state of states) {
      store.set({ currentState: state });
      store.resetToIdle();
      expect(store.get().currentState).toBe('idle');
    }
  });
});

describe('ObservableStateStore - subscriber edge cases', () => {
  it('should handle double unsubscribe gracefully', () => {
    const store = new ObservableStateStore(createInitialState());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.set({ turnCount: 1 });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    unsubscribe(); // double unsubscribe should not throw

    store.set({ turnCount: 2 });
    expect(listener).toHaveBeenCalledTimes(1); // still only called once
  });

  it('should not notify a subscriber added during notification', () => {
    const store = new ObservableStateStore(createInitialState());
    const callOrder: string[] = [];

    const listener1 = vi.fn(() => {
      callOrder.push('listener1');
      // listener1 adds listener3 during notification
      store.subscribe(listener3);
    });

    const listener2 = vi.fn(() => {
      callOrder.push('listener2');
    });

    const listener3 = vi.fn(() => {
      callOrder.push('listener3');
    });

    store.subscribe(listener1);
    store.subscribe(listener2);

    store.set({ turnCount: 1 });

    // listener3 was added during iteration, but the snapshot was taken before
    // so listener3 should NOT be called on this set()
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
    expect(listener3).toHaveBeenCalledTimes(0);
    expect(callOrder).toEqual(['listener1', 'listener2']);
  });

  it('should handle a subscriber removing itself during notification', () => {
    const store = new ObservableStateStore(createInitialState());
    let unsub: () => void;

    const selfRemoving = vi.fn(() => {
      unsub(); // remove itself during callback
    });
    const other = vi.fn();

    unsub = store.subscribe(selfRemoving);
    store.subscribe(other);

    store.set({ turnCount: 1 });

    expect(selfRemoving).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);

    // After self-removal, only 'other' should fire
    store.set({ turnCount: 2 });
    expect(selfRemoving).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it('should not notify any listeners if there are none', () => {
    const store = new ObservableStateStore(createInitialState());
    // Just set state with no subscribers - should not throw
    store.set({ turnCount: 1 });
    store.set({ turnCount: 2 });
    expect(store.get().turnCount).toBe(2);
  });

  it('should return current state from set()', () => {
    const store = new ObservableStateStore(createInitialState());
    const result = store.set({ turnCount: 42 });
    expect(result).toEqual(expect.objectContaining({ turnCount: 42 }));
    // get() returns a shallow copy, so deep equality is the right check
    expect(result).toEqual(store.get());
  });
});

describe('ObservableStateStore - updateToolExecution notifies subscribers', () => {
  it('should notify subscribers when a tool execution is added', () => {
    const store = new ObservableStateStore(createInitialState());
    const listener = vi.fn();
    store.subscribe(listener);

    store.updateToolExecution('tool-1', makeToolExec());

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        activeToolExecutions: expect.any(Map),
      }),
    );
  });

  it('should notify subscribers when removeToolExecution is called', () => {
    const store = new ObservableStateStore(createInitialState());
    store.updateToolExecution('tool-1', makeToolExec());

    const listener = vi.fn();
    store.subscribe(listener);

    store.removeToolExecution('tool-1');

    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('createInitialState - comprehensive defaults', () => {
  it('should set all boolean flags to false by default', () => {
    const state = createInitialState();
    expect(state.verbose).toBe(false);
    expect(state.printMode).toBe(false);
    expect(state.bareMode).toBe(false);
  });

  it('should set token and turn counters to zero', () => {
    const state = createInitialState();
    expect(state.turnCount).toBe(0);
    expect(state.totalTokensUsed).toBe(0);
    expect(state.compactFailureCount).toBe(0);
  });

  it('should set null-able fields to null by default', () => {
    const state = createInitialState();
    expect(state.maxBudgetUsd).toBeNull();
    expect(state.lastCompactedAt).toBeNull();
  });

  it('should create an empty activeToolExecutions map', () => {
    const state = createInitialState();
    expect(state.activeToolExecutions).toBeInstanceOf(Map);
    expect(state.activeToolExecutions.size).toBe(0);
  });

  it('should set timestamps to approximately current time', () => {
    const before = Date.now();
    const state = createInitialState();
    const after = Date.now();

    expect(state.createdAt).toBeGreaterThanOrEqual(before);
    expect(state.createdAt).toBeLessThanOrEqual(after);
    expect(state.lastActivityAt).toBe(state.createdAt);
  });

  it('should generate a unique sessionId', () => {
    const s1 = createInitialState();
    const s2 = createInitialState();
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  it('should use deepseek as default provider', () => {
    const state = createInitialState();
    expect(state.provider).toBe('deepseek');
    expect(state.model).toBe('deepseek-v4-pro');
  });

  it('should override deeply nested values', () => {
    const state = createInitialState({
      maxTokens: 8192,
      maxTurns: 100,
      permissionMode: 'auto-approve',
    });
    expect(state.maxTokens).toBe(8192);
    expect(state.maxTurns).toBe(100);
    expect(state.permissionMode).toBe('auto-approve');
    // Non-overridden fields still default
    expect(state.model).toBe('deepseek-v4-pro');
  });
});
