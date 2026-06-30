import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObservableStateStore, createInitialState } from '../../src/state/store';

describe('ObservableStateStore', () => {
  it('should return initial state', () => {
    const store = new ObservableStateStore(createInitialState());
    const state = store.get();
    expect(state.currentState).toBe('idle');
    expect(state.turnCount).toBe(0);
    expect(state.totalTokensUsed).toBe(0);
  });

  it('should update state immutably', () => {
    const store = new ObservableStateStore(createInitialState());
    const state1 = store.get();
    store.set({ turnCount: 5 });
    const state2 = store.get();
    expect(state1.turnCount).toBe(0);
    expect(state2.turnCount).toBe(5);
  });

  it('should notify listeners on state change', () => {
    const store = new ObservableStateStore(createInitialState());
    const listener = vi.fn();
    store.subscribe(listener);
    store.set({ turnCount: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ turnCount: 1 }));
  });

  it('should support multiple listeners', () => {
    const store = new ObservableStateStore(createInitialState());
    const listener1 = vi.fn();
    const listener2 = vi.fn();
    store.subscribe(listener1);
    store.subscribe(listener2);
    store.set({ turnCount: 1 });
    expect(listener1).toHaveBeenCalledTimes(1);
    expect(listener2).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe correctly', () => {
    const store = new ObservableStateStore(createInitialState());
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.set({ turnCount: 1 });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.set({ turnCount: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('should increment turn count', () => {
    const store = new ObservableStateStore(createInitialState());
    store.incrementTurn();
    store.incrementTurn();
    expect(store.get().turnCount).toBe(2);
  });

  it('should add token usage', () => {
    const store = new ObservableStateStore(createInitialState());
    store.addTokenUsage(100);
    store.addTokenUsage(200);
    expect(store.get().totalTokensUsed).toBe(300);
  });

  it('should update specific field', () => {
    const store = new ObservableStateStore(createInitialState());
    store.updateField('model', 'gpt-4');
    expect(store.get().model).toBe('gpt-4');
  });

  it('should reset to idle', () => {
    const store = new ObservableStateStore(createInitialState());
    store.set({ currentState: 'streaming', turnCount: 5 });
    store.resetToIdle();
    expect(store.get().currentState).toBe('idle');
    expect(store.get().activeToolExecutions.size).toBe(0);
  });

  it('should track listener count', () => {
    const store = new ObservableStateStore(createInitialState());
    expect(store.getListenerCount()).toBe(0);
    const unsub1 = store.subscribe(() => {});
    expect(store.getListenerCount()).toBe(1);
    const unsub2 = store.subscribe(() => {});
    expect(store.getListenerCount()).toBe(2);
    unsub1();
    expect(store.getListenerCount()).toBe(1);
  });

  it('should clear listeners', () => {
    const store = new ObservableStateStore(createInitialState());
    store.subscribe(() => {});
    store.subscribe(() => {});
    expect(store.getListenerCount()).toBe(2);
    store.clearListeners();
    expect(store.getListenerCount()).toBe(0);
  });

  it('should handle listener errors gracefully', () => {
    const store = new ObservableStateStore(createInitialState());
    const badListener = vi.fn(() => { throw new Error('listener error'); });
    const goodListener = vi.fn();
    store.subscribe(badListener);
    store.subscribe(goodListener);
    // Should not throw
    store.set({ turnCount: 1 });
    expect(goodListener).toHaveBeenCalledTimes(1);
  });
});

describe('createInitialState', () => {
  it('should create state with defaults', () => {
    const state = createInitialState();
    expect(state.currentState).toBe('idle');
    expect(state.turnCount).toBe(0);
    expect(state.maxTurns).toBe(80);
    expect(state.model).toBe('deepseek-v4-pro');
  });

  it('should accept overrides', () => {
    const state = createInitialState({ model: 'gpt-4', maxTurns: 10 });
    expect(state.model).toBe('gpt-4');
    expect(state.maxTurns).toBe(10);
  });
});
