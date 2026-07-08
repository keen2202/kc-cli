// Global state management

import type { PermissionMode } from '../permissions/protocol';
import type { Config } from './config';
import { getServiceContainer } from '../services/ServiceContainer';
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

let state: GlobalState | null = null;

// Scoped state for per-agent isolation (used by sub-agents)
const scopedStateStorage = new AsyncLocalStorage<GlobalState>();

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
  // First check for scoped state (per-agent isolation for sub-agents)
  const scoped = scopedStateStorage.getStore();
  if (scoped) {
    return scoped;
  }
  // Then try the container (if initialized via container)
  const container = getServiceContainer();
  if (container.has('globalState')) {
    return container.resolve<GlobalState>('globalState');
  }
  if (!state) {
    throw new Error('Global state not initialized');
  }
  return state;
}

export function initializeState(overrides: Partial<GlobalState> = {}): GlobalState {
  state = {
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
  // Register with container for DI consumers
  getServiceContainer().register('globalState', () => state!, 'singleton');
  return state;
}

export function updateState(updates: Partial<GlobalState>): void {
  const currentState = getState();
  Object.assign(currentState, updates);
}

/**
 * Reset global state (for testing isolation)
 */
export function resetState(): void {
  state = null;
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
