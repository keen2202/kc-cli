// T32 (M7): clear() and restoreSession() share one per-query state reset — round4 §6-M7
//
// Field-whitelist assertion: after EITHER entry point, every per-query state
// field must sit at its initial value. Previously the 13-line reset block was
// duplicated in both methods and could drift.

import { describe, it, expect, beforeEach } from 'vitest';
import { QueryEngine } from '../../src/query/QueryEngine';
import { initializeState } from '../../src/bootstrap/state';
import type { SessionSnapshot } from '../../src/memory/types';

function makeEngine() {
  return new QueryEngine(
    {
      model: 'test-model',
      provider: 'anthropic',
      apiKey: 'test-key',
      maxTurns: 10,
      maxBudgetUsd: null,
      sandboxFailIfNoSandbox: false,
    },
    [],
  );
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'snap-1',
    messages: [
      { id: '1', role: 'system', content: 'sys', timestamp: 1 },
      { id: '2', role: 'user', content: 'hello', timestamp: 2 },
      { id: '3', role: 'assistant', content: 'hi', timestamp: 3 },
    ],
    state: {
      cwd: '/test',
      model: 'test-model',
      provider: 'anthropic',
      turnCount: 5,
      totalTokensUsed: 1000,
    },
    metadata: {
      createdAt: Date.now(),
      lastModified: Date.now(),
      toolsUsed: ['read'],
    },
    ...overrides,
  } as SessionSnapshot;
}

/** Per-field initial-value whitelist. */
function expectCleanState(engine: QueryEngine): void {
  const e = engine as unknown as Record<string, unknown>;
  expect((e.steerQueue as unknown[]).length).toBe(0);
  expect((e.followUpQueue as unknown[]).length).toBe(0);
  expect((e.modifiedFiles as Set<string>).size).toBe(0);
  expect((e.readHistory as Set<unknown>).size).toBe(0);
  expect((e.editHistory as Map<unknown, unknown>).size).toBe(0);
  expect(e._aborted).toBe(false);
  expect((e.progress as { lastModifiedTurn: number }).lastModifiedTurn).toBe(0);
  expect((e.progress as { lastProgressTurn: number }).lastProgressTurn).toBe(0);
  // State machine is back to idle.
  const sm = e.stateMachine as { currentState: string };
  expect(sm.currentState).toBe('idle');
  // Budget counters were reset.
  const budget = e.budgetEnforcer as { getSessionUsage(): { tokens: number } };
  expect(budget.getSessionUsage().tokens).toBe(0);
}

beforeEach(() => {
  initializeState({ cwd: '/test', permissionMode: 'default' });
});

describe('T32: resetPerQueryState shared by clear and restoreSession', () => {
  it('clear() leaves every per-query field at its initial value', () => {
    const engine = makeEngine();
    // Dirty the fields the way a query would.
    (engine as unknown as { steerQueue: unknown[] }).steerQueue.push({});
    (engine as unknown as { _aborted: boolean })._aborted = true;
    (engine as unknown as { progress: { lastModifiedTurn: number } }).progress.lastModifiedTurn = 9;
    (engine as unknown as { budgetEnforcer: { recordUsage(t: number): void } }).budgetEnforcer.recordUsage(500);
    // Force the state machine out of idle via the public runtime control if any;
    // a dirty readHistory/modifiedFiles works for the field checks regardless.
    (engine as unknown as { modifiedFiles: Set<string> }).modifiedFiles.add('src/a.ts');

    engine.clear();
    expectCleanState(engine);
  });

  it('restoreSession() leaves every per-query field at its initial value and loads messages', () => {
    const engine = makeEngine();
    (engine as unknown as { steerQueue: unknown[] }).steerQueue.push({});
    (engine as unknown as { _aborted: boolean })._aborted = true;
    (engine as unknown as { modifiedFiles: Set<string> }).modifiedFiles.add('src/a.ts');
    (engine as unknown as { budgetEnforcer: { recordUsage(t: number): void } }).budgetEnforcer.recordUsage(500);

    const turnCount = engine.restoreSession(makeSnapshot());

    expect(turnCount).toBe(5);
    expectCleanState(engine);
    // Messages were replaced from the snapshot.
    expect(engine.getMessages().length).toBe(3);
  });
});
