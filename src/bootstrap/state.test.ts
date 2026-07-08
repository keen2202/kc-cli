import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createScopedState,
  runWithScopedState,
  getState,
  initializeState,
  resetState,
  updateState,
} from './state';

describe('createScopedState', () => {
  beforeEach(() => {
    initializeState({ cwd: '/parent', permissionMode: 'default' });
  });

  afterEach(() => {
    resetState();
  });

  it('creates a scoped copy with overrides that does not affect parent state', () => {
    const parent = getState();
    expect(parent.cwd).toBe('/parent');

    // Create scoped child state with different cwd
    const childState = createScopedState(parent, { cwd: '/child' });
    expect(childState.cwd).toBe('/child');
    expect(parent.cwd).toBe('/parent');

    // Mutate the child's cwd
    childState.cwd = '/child2';

    // Assert parent is unchanged — AC-A1.2
    expect(parent.cwd).toBe('/parent');
    expect(childState.cwd).toBe('/child2');
  });

  it('preserves parent fields not overridden', () => {
    const parent = getState();
    const childState = createScopedState(parent, { cwd: '/child' });

    expect(childState.permissionMode).toBe(parent.permissionMode);
    expect(childState.sessionId).toBe(parent.sessionId);
    expect(childState.verbose).toBe(parent.verbose);
  });

  it('overrides specified fields', () => {
    const parent = getState();
    const childState = createScopedState(parent, {
      cwd: '/child',
      permissionMode: 'bypassPermissions',
    });

    expect(childState.cwd).toBe('/child');
    expect(childState.permissionMode).toBe('bypassPermissions');
  });
});

describe('runWithScopedState / getState scoped isolation', () => {
  beforeEach(() => {
    initializeState({ cwd: '/parent', permissionMode: 'default' });
  });

  afterEach(() => {
    resetState();
  });

  it('getState() returns scoped state inside runWithScopedState', () => {
    const parent = getState();
    const childState = createScopedState(parent, { cwd: '/child' });

    runWithScopedState(childState, () => {
      // Inside scoped context — getState() returns child state
      const current = getState();
      expect(current.cwd).toBe('/child');
      expect(current).toBe(childState);
    });

    // Outside scoped context — getState() returns global state
    expect(getState().cwd).toBe('/parent');
  });

  it('mutations inside scoped context do not affect global state — AC-A1.2', () => {
    const parent = getState();
    const childState = createScopedState(parent, { cwd: '/child' });

    runWithScopedState(childState, () => {
      // Mutate child state via updateState (which does Object.assign)
      updateState({ cwd: '/child2' });
      expect(getState().cwd).toBe('/child2');
    });

    // Global state is unaffected
    expect(getState().cwd).toBe('/parent');
  });

  it('nested scoped contexts are isolated from each other', async () => {
    const parent = getState();

    const child1 = createScopedState(parent, { cwd: '/child1' });
    const child2 = createScopedState(parent, { cwd: '/child2' });

    await Promise.all([
      // Simulate two sub-agents running concurrently with different scoped state
      new Promise<void>((resolve) => {
        runWithScopedState(child1, async () => {
          // Simulate async work
          await new Promise((r) => setTimeout(r, 10));
          expect(getState().cwd).toBe('/child1');
          updateState({ cwd: '/child1-modified' });
          expect(getState().cwd).toBe('/child1-modified');
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        runWithScopedState(child2, async () => {
          await new Promise((r) => setTimeout(r, 5));
          expect(getState().cwd).toBe('/child2');
          // child2's cwd should be unaffected by child1's updateState
          expect(getState().cwd).not.toBe('/child1-modified');
          resolve();
        });
      }),
    ]);

    // Global state still unaffected
    expect(getState().cwd).toBe('/parent');
  });
});
