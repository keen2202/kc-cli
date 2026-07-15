// Global State Management Tests
// Covers: getState, initializeState, updateState, resetState, findProjectRoot, generateSessionId
//
// Uses vi.mock('fs') to control project root detection in findProjectRoot.
// Uses vi.spyOn(process, 'cwd') to control the starting directory for those tests.
// Default mock behavior delegates to real fs.existsSync so non-mocked tests work normally.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getState, initializeState, updateState, resetState } from '../../src/bootstrap/state';

// ── fs.existsSync Mocking ─────────────────────────────────────────────────
// We need hoisted references so the vi.mock factory (also hoisted) can share
// state with our beforeEach/test blocks.

const { mockExistsSync, realExistsSyncRef } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  realExistsSyncRef: { current: null as ((path: string) => boolean) | null },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  realExistsSyncRef.current = actual.existsSync;
  mockExistsSync.mockImplementation((...args: Parameters<typeof actual.existsSync>) =>
    actual.existsSync(...args),
  );
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Global State Management', () => {
  beforeEach(() => {
    resetState();
    // Reset mock to default (delegate to real fs.existsSync)
    mockExistsSync.mockReset();
    if (realExistsSyncRef.current) {
      mockExistsSync.mockImplementation((...args) =>
        realExistsSyncRef.current!(...args),
      );
    }
  });

  // ── 1. getState ───────────────────────────────────────────────────────

  describe('getState', () => {
    it('should throw "Global state not initialized" before initialization', () => {
      expect(() => getState()).toThrow('GlobalState not initialized');
    });

    it('should return consistent reference on multiple calls after initialization', () => {
      initializeState();
      const ref1 = getState();
      const ref2 = getState();
      expect(ref1).toBe(ref2);
    });

    it('should return the module-level state after initialization', () => {
      const initState = initializeState();
      const retrieved = getState();
      expect(retrieved).toBe(initState);
      expect(retrieved.cwd).toBe(process.cwd());
    });
  });

  // ── 2-4. initializeState ──────────────────────────────────────────────

  describe('initializeState', () => {
    it('should return a valid GlobalState object with defaults', () => {
      const state = initializeState();

      expect(state).toBeDefined();
      expect(typeof state.cwd).toBe('string');
      expect(state.cwd).toBe(process.cwd());
      expect(state.sessionId).toMatch(/^session_\d+_[a-z0-9]+$/);
      expect(state.permissionMode).toBe('default');
      expect(state.verbose).toBe(false);
      expect(state.printMode).toBe(false);
      expect(state.bareMode).toBe(false);
      expect(state.maxTurns).toBeNull();
      expect(state.maxBudgetUsd).toBeNull();
      expect(state.config).toBeNull();
    });

    it('should apply partial overrides', () => {
      const state = initializeState({
        verbose: true,
        permissionMode: 'dontAsk',
        bareMode: true,
        maxBudgetUsd: 5.0,
      });

      expect(state.verbose).toBe(true);
      expect(state.permissionMode).toBe('dontAsk');
      expect(state.bareMode).toBe(true);
      expect(state.maxBudgetUsd).toBe(5.0);
      // Default fields remain unchanged
      expect(state.printMode).toBe(false);
      expect(state.maxTurns).toBeNull();
      expect(state.config).toBeNull();
    });

    it('should set module-level state so getState resolves', () => {
      initializeState();
      // Should not throw and return the same state
      const state = getState();
      expect(state).toBeDefined();
      expect(typeof state.sessionId).toBe('string');
    });
  });

  // ── 5. updateState ────────────────────────────────────────────────────

  describe('updateState', () => {
    it('should merge partial updates into the current state', () => {
      initializeState();
      const state = getState();
      expect(state.verbose).toBe(false);
      expect(state.bareMode).toBe(false);

      updateState({ verbose: true, bareMode: true });

      // Same object reference updated in-place
      expect(state.verbose).toBe(true);
      expect(state.bareMode).toBe(true);
      // Unchanged fields preserved
      expect(state.permissionMode).toBe('default');
    });

    it('should throw if state is not initialized', () => {
      expect(() => updateState({ verbose: true })).toThrow(
        'GlobalState not initialized',
      );
    });
  });

  // ── 6-7. resetState ───────────────────────────────────────────────────

  describe('resetState', () => {
    it('should clear module-level state so subsequent initializeState produces a fresh state', () => {
      const state1 = initializeState({ verbose: true });
      const session1 = state1.sessionId;

      resetState();

      // After reset, a new initializeState creates a completely fresh state:
      // different overrides, different sessionId, different object reference.
      const state2 = initializeState({ verbose: false, permissionMode: 'dontAsk' });
      expect(state2.verbose).toBe(false);
      expect(state2.permissionMode).toBe('dontAsk');
      expect(state2.sessionId).not.toBe(session1);
      expect(state2).not.toBe(state1);
    });

    it('should throw after resetState clears the module-level state', () => {
      initializeState();
      resetState();
      expect(() => getState()).toThrow('GlobalState not initialized');
    });
  });

  // ── 9-10. findProjectRoot (exercised through initializeState) ─────────

  describe('findProjectRoot', () => {
    let cwdSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // Override mock to return false for all marker paths
      mockExistsSync.mockReset();
      mockExistsSync.mockReturnValue(false);
    });

    afterEach(() => {
      cwdSpy?.mockRestore();
    });

    it('should return null when no project markers are found', () => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp');
      const state = initializeState();
      expect(state.projectRoot).toBeNull();
    });

    it('should detect project root by package.json marker in cwd', () => {
      mockExistsSync.mockImplementation(
        (fp: string) => fp === '/tmp/my-project/package.json',
      );
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/my-project');
      const state = initializeState();
      expect(state.projectRoot).toBe('/tmp/my-project');
    });

    it('should detect project root by .git marker in cwd', () => {
      mockExistsSync.mockImplementation(
        (fp: string) => fp === '/tmp/repo/.git',
      );
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/repo');
      const state = initializeState();
      expect(state.projectRoot).toBe('/tmp/repo');
    });

    it('should detect project root by .kc-cli marker in cwd', () => {
      mockExistsSync.mockImplementation(
        (fp: string) => fp === '/tmp/custom/.kc-cli',
      );
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/custom');
      const state = initializeState();
      expect(state.projectRoot).toBe('/tmp/custom');
    });

    it('should detect project root by Cargo.toml marker in cwd', () => {
      mockExistsSync.mockImplementation(
        (fp: string) => fp === '/tmp/rust-project/Cargo.toml',
      );
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/rust-project');
      const state = initializeState();
      expect(state.projectRoot).toBe('/tmp/rust-project');
    });

    it('should detect project root by go.mod marker in cwd', () => {
      mockExistsSync.mockImplementation(
        (fp: string) => fp === '/tmp/go-app/go.mod',
      );
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/go-app');
      const state = initializeState();
      expect(state.projectRoot).toBe('/tmp/go-app');
    });

    it('should detect project root by CMakeLists.txt marker in cwd', () => {
      mockExistsSync.mockImplementation(
        (fp: string) => fp === '/tmp/cmake-project/CMakeLists.txt',
      );
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/cmake-project');
      const state = initializeState();
      expect(state.projectRoot).toBe('/tmp/cmake-project');
    });

    it('should detect project root by pyproject.toml marker in cwd', () => {
      mockExistsSync.mockImplementation(
        (fp: string) => fp === '/tmp/python-lib/pyproject.toml',
      );
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/python-lib');
      const state = initializeState();
      expect(state.projectRoot).toBe('/tmp/python-lib');
    });

    it('should detect project root in a parent directory', () => {
      // Only .git exists in /tmp/parent, not in /tmp/parent/child
      const markerPaths = new Set(['/tmp/parent/.git']);
      mockExistsSync.mockImplementation((fp: string) => markerPaths.has(fp));
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/parent/child');
      const state = initializeState();
      expect(state.projectRoot).toBe('/tmp/parent');
    });

    it('should stop at filesystem root without finding markers', () => {
      // No markers anywhere — loop reaches "/" and returns null
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/tmp/a/b');
      const state = initializeState();
      expect(state.projectRoot).toBeNull();
    });
  });

  // ── 10. generateSessionId (exercised through initializeState) ─────────

  describe('generateSessionId', () => {
    it('should produce a non-empty string starting with session_', () => {
      const state = initializeState();
      expect(state.sessionId).toMatch(/^session_/);
      expect(state.sessionId.length).toBeGreaterThan('session_'.length);
    });

    it('should produce unique IDs on multiple initializations', () => {
      const id1 = initializeState().sessionId;
      resetState();
      const id2 = initializeState().sessionId;
      resetState();
      const id3 = initializeState().sessionId;

      // Each ID should be distinct (different timestamps and random parts)
      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
      expect(id1).not.toBe(id3);
    });
  });
});
