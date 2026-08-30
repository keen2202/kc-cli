// O4: budget denials must leave a warn-level trace — round4 §4-O4
//
// D1: the unlimited default is deliberate; these tests only assert that
// denials are *visible*, never that a default limit was introduced.

import { describe, it, expect, afterEach } from 'vitest';
import { BudgetEnforcer, DEFAULT_BUDGET_CONFIG } from '../../src/services/budget';
import type { ToolResult } from '../../src/tools/protocol';
import { spyOnLogger, type LoggerSpy } from '../helpers/logger-spy';

describe('O4: budget denial logging', () => {
  let spy: LoggerSpy;

  afterEach(() => {
    spy?.stop();
  });

  it('warns with kind/tokens/costUsd/limit when the cost limit fires', () => {
    spy = spyOnLogger('services', ['warn']);
    const enforcer = new BudgetEnforcer({ costLimitUsd: 0.01 });

    const check = enforcer.checkTurnBudget(100, 0.5);

    expect(check.allowed).toBe(false);
    expect(spy.calls.length).toBe(1);
    expect(spy.calls[0]!.message).toBe('budget exceeded');
    expect(spy.calls[0]!.data).toMatchObject({
      kind: 'cost_limit:turn',
      tokens: null,
      costUsd: expect.any(Number),
      limit: 0.01,
    });
  });

  it('warns for each denial kind (session / turn / tool-result / sub-agent)', () => {
    spy = spyOnLogger('services', ['warn']);
    const toolResult: ToolResult = { success: true, output: 'x'.repeat(200) };

    const session = new BudgetEnforcer({ sessionTokenLimit: 10 }).checkTurnBudget(50);
    expect(session.allowed).toBe(false);

    const turn = new BudgetEnforcer({ turnTokenLimit: 10 }).checkTurnBudget(50);
    expect(turn.allowed).toBe(false);

    const tool = new BudgetEnforcer({ toolResultTokenLimit: 10 }).checkToolResultBudget(toolResult);
    expect(tool.allowed).toBe(false);

    const sub = new BudgetEnforcer({ subAgentTokenLimit: 10 }).checkSubAgentBudget(50);
    expect(sub.allowed).toBe(false);

    const kinds = spy.calls.map((c) => c.data?.kind);
    expect(kinds).toEqual([
      'session_token_limit:turn',
      'turn_token_limit',
      'tool_result_token_limit',
      'sub_agent_token_limit',
    ]);
  });

  it('does not log when the check passes and the default config stays unlimited', () => {
    spy = spyOnLogger('services', ['warn']);
    const enforcer = new BudgetEnforcer();

    expect(enforcer.checkTurnBudget(1_000_000).allowed).toBe(true);
    expect(DEFAULT_BUDGET_CONFIG.costLimitUsd).toBeNull();
    expect(spy.calls.length).toBe(0);
  });
});
