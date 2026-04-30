// Global state management

import type { PermissionMode } from '../types/permissions';
import * as fs from 'fs';
import * as path from 'path';

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
}

let state: GlobalState | null = null;

export function getState(): GlobalState {
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
    ...overrides,
  };
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
