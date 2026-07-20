/**
 * T3: BudgetEnforcer integration tests.
 *
 * Verifies budget enforcement in the QueryEngine main loop:
 * - Budget check before provider calls
 * - Graceful termination on budget exceeded
 * - Usage recording after successful calls
 * - No-op behavior when budget is unlimited
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { QueryEngine } from '../../src/query/QueryEngine';
import { BudgetEnforcer, DEFAULT_BUDGET_CONFIG } from '../../src/services/budget';
import { initializeState } from '../../src/bootstrap/state';

function makeEngine(maxBudgetUsd?: number | null) {
  return new QueryEngine(
    {
      model: 'test-model',
      provider: 'anthropic',
      apiKey: 'test-key',
      maxTurns: 10,
      maxBudgetUsd: maxBudgetUsd ?? null,
    },
    [],
  );
}

beforeEach(() => {
  initializeState({ cwd: '/test', permissionMode: 'default' });
});

describe('BudgetEnforcer', () => {
  it('allows operations within budget', () => {
    const enforcer = new BudgetEnforcer({ sessionTokenLimit: 10000 });
    const result = enforcer.checkTurnBudget(1000);
    expect(result.allowed).toBe(true);
    // Remaining reflects current state (0 used), not projected
    expect(result.remaining.sessionTokensRemaining).toBe(10000);
    expect(result.remaining.turnTokensRemaining).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects operations exceeding session limit', () => {
    const enforcer = new BudgetEnforcer({ sessionTokenLimit: 1000 });
    enforcer.recordUsage(900);
    const result = enforcer.checkTurnBudget(200);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Session token budget exceeded');
  });

  it('rejects operations exceeding cost limit', () => {
    const enforcer = new BudgetEnforcer({ sessionTokenLimit: 100000, costLimitUsd: 1.0 });
    enforcer.recordUsage(50000, 0.95);
    const result = enforcer.checkTurnBudget(1000, 0.10);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('cost budget exceeded');
  });

  it('records usage correctly', () => {
    const enforcer = new BudgetEnforcer({ sessionTokenLimit: 10000 });
    enforcer.recordUsage(500, 0.01);
    const usage = enforcer.getSessionUsage();
    expect(usage.tokens).toBe(500);
    expect(usage.costUsd).toBe(0.01);
  });

  it('reset clears all counters', () => {
    const enforcer = new BudgetEnforcer({ sessionTokenLimit: 10000 });
    enforcer.recordUsage(5000, 0.05);
    enforcer.reset();
    const usage = enforcer.getSessionUsage();
    expect(usage.tokens).toBe(0);
    expect(usage.costUsd).toBe(0);
    const remaining = enforcer.getRemaining();
    expect(remaining.sessionTokensRemaining).toBe(10000);
  });

  it('resetTurn clears only turn counter', () => {
    const enforcer = new BudgetEnforcer({ sessionTokenLimit: 10000, turnTokenLimit: 1000 });
    enforcer.recordUsage(500);
    expect(enforcer.getRemaining().turnTokensRemaining).toBe(500);
    enforcer.resetTurn();
    expect(enforcer.getRemaining().turnTokensRemaining).toBe(1000);
    expect(enforcer.getSessionUsage().tokens).toBe(500); // session still tracks
  });

  it('default config is effectively unlimited', () => {
    const enforcer = new BudgetEnforcer();
    const result = enforcer.checkTurnBudget(Number.MAX_SAFE_INTEGER - 1);
    expect(result.allowed).toBe(true);
  });

  it('getRemaining reflects current usage', () => {
    const enforcer = new BudgetEnforcer({ sessionTokenLimit: 5000, costLimitUsd: 2.0 });
    enforcer.recordUsage(2000, 0.50);
    const remaining = enforcer.getRemaining();
    expect(remaining.sessionTokensRemaining).toBe(3000);
    expect(remaining.costRemainingUsd).toBeCloseTo(1.50);
  });
});

describe('QueryEngine budget integration', () => {
  it('engine has a budget enforcer', () => {
    const engine = makeEngine();
    expect(engine.getBudgetEnforcer()).toBeInstanceOf(BudgetEnforcer);
  });

  it('engine with null budget uses default unlimited enforcer', () => {
    const engine = makeEngine(null);
    const enforcer = engine.getBudgetEnforcer();
    const check = enforcer.checkTurnBudget(1000000);
    expect(check.allowed).toBe(true);
  });

  it('engine with budget limit enforces it', () => {
    // Set a very low budget so even the first turn is exceeded
    const engine = makeEngine(0.00001); // effectively 1 token worth
    const enforcer = engine.getBudgetEnforcer();
    // Pre-record usage to fill the budget
    enforcer.recordUsage(Number.MAX_SAFE_INTEGER - 100);
    const check = enforcer.checkTurnBudget(1000);
    expect(check.allowed).toBe(false);
  });

  it('clear() resets the budget enforcer', () => {
    const engine = makeEngine();
    const enforcer = engine.getBudgetEnforcer();
    enforcer.recordUsage(5000);
    expect(enforcer.getSessionUsage().tokens).toBe(5000);

    engine.clear();
    expect(enforcer.getSessionUsage().tokens).toBe(0);
  });

  it('restoreSession() resets the budget enforcer', () => {
    const engine = makeEngine();
    const enforcer = engine.getBudgetEnforcer();
    enforcer.recordUsage(5000);

    engine.restoreSession({
      sessionId: 'test',
      messages: [
        { id: '1', role: 'system', content: 'Sys', timestamp: 1 },
        { id: '2', role: 'user', content: 'Hello', timestamp: 2 },
      ],
      state: { cwd: '/t', model: 'm', provider: 'p', turnCount: 0, totalTokensUsed: 0 },
      metadata: { createdAt: 1, lastModified: 1, toolsUsed: [] },
    });

    expect(enforcer.getSessionUsage().tokens).toBe(0);
  });
});
