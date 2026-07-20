/**
 * T1: GlobalState deep isolation tests.
 *
 * Verifies that createScopedState with structuredClone prevents child agents
 * from mutating parent/sibling config, cwd, and permissionMode.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initializeState,
  createScopedState,
  runWithScopedState,
  getState,
  updateState,
  resetState,
} from '../../src/bootstrap/state';
beforeEach(() => {
  resetState();
});

describe('createScopedState deep isolation', () => {
  it('deep-clones config so child mutations do not affect parent', () => {
    const parent = initializeState({
      cwd: '/parent',
      permissionMode: 'default',
      config: { model: 'claude', provider: 'anthropic' } as any,
    });

    const child = createScopedState(parent, {
      cwd: '/child',
      permissionMode: 'bypassPermissions',
    });

    // Mutate child config — must not affect parent
    if (child.config) {
      (child.config as any).model = 'gpt-4';
      (child.config as any).provider = 'openai';
    }
    child.permissionMode = 'acceptEdits';

    expect(parent.config?.model).toBe('claude');
    expect(parent.config?.provider).toBe('anthropic');
    expect(parent.permissionMode).toBe('default');
    expect(parent.cwd).toBe('/parent');
    expect(child.cwd).toBe('/child');
  });

  it('isolates sibling agents from each other', () => {
    const parent = initializeState({
      cwd: '/parent',
      config: { model: 'base' } as any,
    });

    const childA = createScopedState(parent, { cwd: '/childA' });
    const childB = createScopedState(parent, { cwd: '/childB' });

    if (childA.config) (childA.config as any).model = 'model-a';
    if (childB.config) (childB.config as any).model = 'model-b';

    expect((childA.config as any).model).toBe('model-a');
    expect((childB.config as any).model).toBe('model-b');
    expect((parent.config as any).model).toBe('base');
  });

  it('isolates agpRegistry between scoped states', () => {
    const parent = initializeState({ cwd: '/parent' });
    const registryA = {} as any;
    const registryB = {} as any;

    const childA = createScopedState(parent, { agpRegistry: registryA });
    const childB = createScopedState(parent, { agpRegistry: registryB });

    expect(childA.agpRegistry).toBe(registryA);
    expect(childB.agpRegistry).toBe(registryB);
    expect(parent.agpRegistry).toBeUndefined();
  });
});

describe('runWithScopedState ALS propagation', () => {
  it('getState() returns scoped state within ALS context', () => {
    const state = initializeState({ cwd: '/root', permissionMode: 'default' });

    runWithScopedState(state, () => {
      const s = getState();
      expect(s.cwd).toBe('/root');
      expect(s.permissionMode).toBe('default');
    });
  });

  it('getState() returns root fallback outside ALS context', () => {
    const state = initializeState({ cwd: '/outside' });
    // Not wrapped in runWithScopedState — should use root fallback
    const s = getState();
    expect(s.cwd).toBe('/outside');
  });

  it('nested runWithScopedState isolates inner from outer', () => {
    const outer = initializeState({ cwd: '/outer', permissionMode: 'default' });
    const inner = createScopedState(outer, { cwd: '/inner', permissionMode: 'bypassPermissions' });

    runWithScopedState(outer, () => {
      expect(getState().cwd).toBe('/outer');
      expect(getState().permissionMode).toBe('default');

      runWithScopedState(inner, () => {
        expect(getState().cwd).toBe('/inner');
        expect(getState().permissionMode).toBe('bypassPermissions');
      });

      // Back to outer after inner scope exits
      expect(getState().cwd).toBe('/outer');
    });
  });

  it('mutations to nested state do not leak to parent scope', () => {
    const parent = initializeState({
      cwd: '/parent',
      config: { model: 'parent-model' } as any,
    });

    runWithScopedState(parent, () => {
      const child = createScopedState(getState(), { cwd: '/child' });

      runWithScopedState(child, () => {
        const s = getState();
        s.permissionMode = 'acceptEdits';
        if (s.config) (s.config as any).model = 'child-model';
        expect((getState().config as any).model).toBe('child-model');
      });

      // Parent scope: mutations should not have leaked
      expect(getState().permissionMode).toBe('default');
      expect((getState().config as any).model).toBe('parent-model');
    });
  });

  it('getState() throws when no state initialized', () => {
    // resetState() was called in beforeEach, so _rootState is null
    // and no ALS context is active
    expect(() => getState()).toThrow('GlobalState not initialized');
  });
});

describe('updateState within ALS', () => {
  it('updateState mutates the active scoped state', () => {
    const state = initializeState({ cwd: '/update-test', permissionMode: 'default' });

    runWithScopedState(state, () => {
      updateState({ permissionMode: 'acceptEdits' });
      expect(getState().permissionMode).toBe('acceptEdits');
    });
  });
});
