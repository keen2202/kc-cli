import { describe, it, expect, beforeEach } from 'vitest';
import {
  BudgetEnforcer,
  createBudgetExceededError,
  DEFAULT_BUDGET_CONFIG,
} from '../../src/services/budget';
import type { BudgetConfig, BudgetCheckResult } from '../../src/services/budget';
import { KCError } from '../../src/types/errors';

describe('BudgetEnforcer', () => {
  let enforcer: BudgetEnforcer;

  describe('constructor', () => {
    it('should use default config when no config provided', () => {
      enforcer = new BudgetEnforcer();
      const remaining = enforcer.getRemaining();
      expect(remaining.sessionTokensRemaining).toBe(Number.MAX_SAFE_INTEGER);
      expect(remaining.turnTokensRemaining).toBe(Number.MAX_SAFE_INTEGER);
      expect(remaining.costRemainingUsd).toBeNull();
    });

    it('should merge partial config with defaults', () => {
      enforcer = new BudgetEnforcer({ sessionTokenLimit: 1000 });
      const remaining = enforcer.getRemaining();
      expect(remaining.sessionTokensRemaining).toBe(1000);
      expect(remaining.turnTokensRemaining).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('should use full config when provided', () => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 10000,
        turnTokenLimit: 5000,
        toolResultTokenLimit: 2000,
        subAgentTokenLimit: 8000,
        costLimitUsd: 1.0,
      });
      const remaining = enforcer.getRemaining();
      expect(remaining.sessionTokensRemaining).toBe(10000);
      expect(remaining.turnTokensRemaining).toBe(5000);
      expect(remaining.costRemainingUsd).toBe(1.0);
    });
  });

  describe('checkTurnBudget', () => {
    beforeEach(() => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 10000,
        turnTokenLimit: 5000,
        costLimitUsd: null,
      });
    });

    it('should allow when within both session and turn limits', () => {
      const result = enforcer.checkTurnBudget(3000);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('should deny when turn limit would be exceeded', () => {
      const result = enforcer.checkTurnBudget(6000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Turn token budget exceeded');
    });

    it('should deny when session limit would be exceeded', () => {
      // Use up most of session budget
      enforcer.recordUsage(9000);
      const result = enforcer.checkTurnBudget(2000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Session token budget exceeded');
    });

    it('should deny when cost limit is exceeded', () => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 100000,
        turnTokenLimit: 50000,
        costLimitUsd: 1.0,
      });
      enforcer.recordUsage(100, 1.5);
      const result = enforcer.checkTurnBudget(100);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('cost budget exceeded');
    });

    it('should include remaining snapshot in result', () => {
      enforcer.recordUsage(3000);
      const result = enforcer.checkTurnBudget(1000);
      expect(result.remaining.sessionTokensRemaining).toBe(7000);
    });
  });

  describe('checkToolResultBudget', () => {
    beforeEach(() => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 100000,
        turnTokenLimit: 50000,
        toolResultTokenLimit: 100,
        subAgentTokenLimit: 80000,
        costLimitUsd: null,
      });
    });

    it('should allow tool results within the limit', () => {
      const result = enforcer.checkToolResultBudget({
        output: 'small output',
        isError: false,
      });
      expect(result.allowed).toBe(true);
    });

    it('should deny tool results that exceed the token limit', () => {
      // Create a large output that will exceed 100 tokens
      const largeOutput = 'x'.repeat(1000);
      const result = enforcer.checkToolResultBudget({
        output: largeOutput,
        isError: false,
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Tool result token budget exceeded');
    });

    it('should handle non-string outputs via JSON serialization', () => {
      const result = enforcer.checkToolResultBudget({
        output: { key: 'value' } as any,
        isError: false,
      });
      expect(result.allowed).toBe(true);
    });
  });

  describe('checkSubAgentBudget', () => {
    beforeEach(() => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 50000,
        turnTokenLimit: 20000,
        toolResultTokenLimit: 10000,
        subAgentTokenLimit: 30000,
        costLimitUsd: null,
      });
    });

    it('should allow sub-agent within budget', () => {
      const result = enforcer.checkSubAgentBudget(20000);
      expect(result.allowed).toBe(true);
    });

    it('should deny sub-agent that exceeds sub-agent limit', () => {
      const result = enforcer.checkSubAgentBudget(40000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Sub-agent token budget exceeded');
    });

    it('should deny sub-agent that would exceed session limit', () => {
      enforcer.recordUsage(40000);
      const result = enforcer.checkSubAgentBudget(20000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Session token budget exceeded');
    });
  });

  describe('recordUsage', () => {
    beforeEach(() => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 10000,
        turnTokenLimit: 5000,
        costLimitUsd: 2.0,
      });
    });

    it('should track token usage', () => {
      enforcer.recordUsage(1000);
      const usage = enforcer.getSessionUsage();
      expect(usage.tokens).toBe(1000);
    });

    it('should accumulate token usage', () => {
      enforcer.recordUsage(1000);
      enforcer.recordUsage(2000);
      const usage = enforcer.getSessionUsage();
      expect(usage.tokens).toBe(3000);
    });

    it('should track cost usage when provided', () => {
      enforcer.recordUsage(1000, 0.5);
      const usage = enforcer.getSessionUsage();
      expect(usage.costUsd).toBe(0.5);
    });

    it('should accumulate cost usage', () => {
      enforcer.recordUsage(1000, 0.5);
      enforcer.recordUsage(1000, 0.3);
      const usage = enforcer.getSessionUsage();
      expect(usage.costUsd).toBe(0.8);
    });

    it('should update remaining snapshot', () => {
      enforcer.recordUsage(3000);
      const remaining = enforcer.getRemaining();
      expect(remaining.sessionTokensRemaining).toBe(7000);
    });
  });

  describe('resetTurn', () => {
    beforeEach(() => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 10000,
        turnTokenLimit: 5000,
        costLimitUsd: null,
      });
    });

    it('should reset turn token counter', () => {
      enforcer.recordUsage(3000);
      enforcer.resetTurn();
      const remaining = enforcer.getRemaining();
      expect(remaining.turnTokensRemaining).toBe(5000);
    });

    it('should not affect session token counter', () => {
      enforcer.recordUsage(3000);
      enforcer.resetTurn();
      const usage = enforcer.getSessionUsage();
      expect(usage.tokens).toBe(3000);
    });
  });

  describe('getRemaining', () => {
    it('should return full budget when no usage recorded', () => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 10000,
        turnTokenLimit: 5000,
        costLimitUsd: 1.0,
      });
      const remaining = enforcer.getRemaining();
      expect(remaining.sessionTokensRemaining).toBe(10000);
      expect(remaining.turnTokensRemaining).toBe(5000);
      expect(remaining.costRemainingUsd).toBe(1.0);
    });

    it('should never return negative values', () => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 100,
        turnTokenLimit: 50,
        costLimitUsd: 0.1,
      });
      enforcer.recordUsage(200, 0.5);
      const remaining = enforcer.getRemaining();
      expect(remaining.sessionTokensRemaining).toBe(0);
      expect(remaining.turnTokensRemaining).toBe(0);
      expect(remaining.costRemainingUsd).toBe(0);
    });

    it('should return null for cost when no cost limit set', () => {
      enforcer = new BudgetEnforcer({ costLimitUsd: null });
      const remaining = enforcer.getRemaining();
      expect(remaining.costRemainingUsd).toBeNull();
    });
  });

  describe('getSessionUsage', () => {
    it('should return zero initially', () => {
      enforcer = new BudgetEnforcer();
      const usage = enforcer.getSessionUsage();
      expect(usage.tokens).toBe(0);
      expect(usage.costUsd).toBe(0);
    });

    it('should track cumulative usage', () => {
      enforcer = new BudgetEnforcer();
      enforcer.recordUsage(1000, 0.1);
      enforcer.recordUsage(2000, 0.2);
      const usage = enforcer.getSessionUsage();
      expect(usage.tokens).toBe(3000);
      expect(usage.costUsd).toBeCloseTo(0.3);
    });
  });

  describe('budget exceeded scenarios', () => {
    it('should handle session budget exceeded across multiple checks', () => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 5000,
        turnTokenLimit: 10000,
        costLimitUsd: null,
      });

      // First turn: use 3000
      enforcer.recordUsage(3000);
      enforcer.resetTurn();

      // Second turn: check with 3000 estimated (would exceed 5000 session limit)
      const result = enforcer.checkTurnBudget(3000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Session token budget exceeded');
    });

    it('should handle turn budget exceeded after partial usage', () => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 100000,
        turnTokenLimit: 3000,
        costLimitUsd: null,
      });

      enforcer.recordUsage(2000);
      const result = enforcer.checkTurnBudget(2000);
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Turn token budget exceeded');
    });

    it('should allow after turn reset', () => {
      enforcer = new BudgetEnforcer({
        sessionTokenLimit: 100000,
        turnTokenLimit: 3000,
        costLimitUsd: null,
      });

      enforcer.recordUsage(2000);
      enforcer.resetTurn();
      const result = enforcer.checkTurnBudget(2000);
      expect(result.allowed).toBe(true);
    });
  });
});

describe('createBudgetExceededError', () => {
  it('should create a KCError with budget_exceeded code', () => {
    const error = createBudgetExceededError('test reason');
    expect(error).toBeInstanceOf(KCError);
    expect(error.code).toBe('budget_exceeded');
    expect(error.message).toBe('test reason');
  });

  it('should include context when provided', () => {
    const error = createBudgetExceededError('test reason', { tokens: 1000 });
    expect(error.context).toEqual({ tokens: 1000 });
  });
});

describe('DEFAULT_BUDGET_CONFIG', () => {
  it('should have effectively unlimited defaults', () => {
    expect(DEFAULT_BUDGET_CONFIG.sessionTokenLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(DEFAULT_BUDGET_CONFIG.turnTokenLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(DEFAULT_BUDGET_CONFIG.toolResultTokenLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(DEFAULT_BUDGET_CONFIG.subAgentTokenLimit).toBe(Number.MAX_SAFE_INTEGER);
    expect(DEFAULT_BUDGET_CONFIG.costLimitUsd).toBeNull();
  });
});
