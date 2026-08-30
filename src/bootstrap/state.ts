// Global state management

import type { PermissionMode } from '../permissions/protocol';
import type { Config } from './config';
import type { GlobalRegistry } from '../agp/registry';
import * as fs from 'fs';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';

export interface GlobalState {
  cwd: string;
  projectRoot: string | null;
  sessionId: string;
  permissionMode: PermissionMode;
  verbose: boolean;
  printMode: boolean;
  bareMode: boolean;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  config: Config | null;
  /** AGP Global Registry (initialized lazily) */
  agpRegistry?: GlobalRegistry;
  /**
   * T4 (H4): whether `cwd` is inside a Git work tree, probed once at bootstrap.
   * `undefined` = not yet probed (e.g. tests / legacy callers); `false` means
   * the Git auto-stage/commit safety net is unavailable and rollback relies on
   * the T2 `.kc-cli/backups/` snapshots surfaced via FileRestore.
   */
  isGitRepo?: boolean;
  /**
   * O3 (round4): MCP servers whose reconnect budget is exhausted, appended by
   * Bootstrap when the client manager reports final failure. The UI status
   * surface reads this to explain why an MCP integration's tools vanished.
   */
  unavailableMcpServers?: Array<{ serverId: string; reason: string; at: string }>;
}

// Scoped state for per-agent isolation (used by sub-agents)
const scopedStateStorage = new AsyncLocalStorage<GlobalState>();

/**
 * Root-level state set by initializeState().
 * Used as a fallback when no ALS context is active (e.g. in tests, REPL, or
 * code paths that haven't been migrated to runWithScopedState yet).
 * Sub-agents MUST use runWithScopedState + createScopedState for isolation;
 * they must never mutate this shared root reference.
 */
let _rootState: GlobalState | null = null;

/**
 * Create a scoped copy of global state with overridden fields.
 * Uses structuredClone for deep isolation so nested objects (config, etc.)
 * are not shared between parent and child agents. Mutations by the child
 * cannot pollute the parent or sibling agents.
 */
export function createScopedState(parent: GlobalState, overrides: Partial<GlobalState>): GlobalState {
  const cloned = structuredClone(parent) as GlobalState;
  return Object.assign(cloned, overrides);
}

/**
 * Run a function (sync or async) within a scoped state context.
 * getState() returns the scoped state for the duration of the
 * function and all async operations within its promise chain.
 */
export function runWithScopedState<T>(state: GlobalState, fn: () => T): T {
  return scopedStateStorage.run(state, fn);
}

export function getState(): GlobalState {
  const scoped = scopedStateStorage.getStore();
  if (scoped) {
    return scoped;
  }
  // Root-level fallback for code paths not yet wrapped in runWithScopedState
  // (e.g. tests, REPL, legacy callers). Sub-agents always use ALS.
  if (_rootState) {
    return _rootState;
  }
  throw new Error(
    'GlobalState not initialized. Call initializeState() and wrap with runWithScopedState().'
  );
}

export function initializeState(overrides: Partial<GlobalState> = {}): GlobalState {
  _rootState = {
    cwd: process.cwd(),
    projectRoot: findProjectRoot(process.cwd()),
    sessionId: generateSessionId(),
    permissionMode: 'default',
    verbose: false,
    printMode: false,
    bareMode: false,
    maxTurns: null,
    maxBudgetUsd: null,
    config: null,
    ...overrides,
  };
  return _rootState;
}

export function updateState(updates: Partial<GlobalState>): void {
  const currentState = getState();
  Object.assign(currentState, updates);
}

/**
 * Reset root state (for testing isolation between test cases).
 * Clears the root-level fallback. Tests should call initializeState() in
 * beforeEach to set up fresh state for each case.
 */
export function resetState(): void {
  _rootState = null;
}

function findProjectRoot(dir: string): string | null {
  const markers = [
    '.git',
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'CMakeLists.txt',
    '.kc-cli',
  ];

  let current = dir;
  // Walk up until a marker is found or we reach the filesystem root.
  // `path.dirname(root) === root` on every platform (POSIX '/' and Windows
  // drive roots like 'd:\\'), which is the portable loop terminator. The
  // previous `current !== '/'` guard never matched a Windows drive root and
  // could spin forever at the top of the tree (bootstrap hang).
  while (true) {
    for (const marker of markers) {
      try {
        const filePath = path.join(current, marker);
        if (fs.existsSync(filePath)) {
          return current;
        }
      } catch {
        // File doesn't exist, continue
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break; // reached filesystem root without finding a marker
    }
    current = parent;
  }

  return null;
}

function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
