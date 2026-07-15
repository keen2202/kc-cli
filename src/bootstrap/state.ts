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
}

// Scoped state for per-agent isolation (used by sub-agents)
const scopedStateStorage = new AsyncLocalStorage<GlobalState>();

/**
 * Transitional fallback for code paths not yet migrated to ALS.
 * TODO(A1): Remove once all callers use runWithScopedState().
 */
let _fallbackState: GlobalState | null = null;

/**
 * Create a scoped copy of global state with overridden fields.
 * Used to provide per-agent isolated state for sub-agents.
 * Returns a new object so mutations by the child do not affect the parent.
 */
export function createScopedState(parent: GlobalState, overrides: Partial<GlobalState>): GlobalState {
  return { ...parent, ...overrides };
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
  // Check for scoped state (per-agent isolation for sub-agents)
  const scoped = scopedStateStorage.getStore();
  if (scoped) {
    return scoped;
  }
  // Transitional fallback for code paths not yet migrated to ALS.
  if (_fallbackState) {
    return _fallbackState;
  }
  throw new Error(
    'GlobalState not initialized. Call initializeState() and wrap with runWithScopedState().'
  );
}

export function initializeState(overrides: Partial<GlobalState> = {}): GlobalState {
  _fallbackState = {
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
  return _fallbackState;
}

export function updateState(updates: Partial<GlobalState>): void {
  const currentState = getState();
  Object.assign(currentState, updates);
}

/**
 * Reset global state (for testing isolation).
 * Clears the transitional fallback. Tests should migrate to initializeState()
 * with runWithScopedState() for proper per-test state isolation.
 */
export function resetState(): void {
  _fallbackState = null;
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
  while (current !== '/' && current !== '.') {
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
    current = path.dirname(current);
  }

  return null;
}

function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}
