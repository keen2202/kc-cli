import { KCError } from '../types/errors';
import type { ToolResult } from '../types/tools';
import { estimateToolResultTokens } from '../utils/tokenEstimation';

/**
 * Budget configuration for token and cost enforcement.
 * All limits are per-session unless noted otherwise.
 */
export interface BudgetConfig {
  /** Maximum total tokens allowed per session */
  sessionTokenLimit: number;
  /** Maximum tokens allowed per single turn (LLM call + tool results) */
  turnTokenLimit: number;
  /** Maximum tokens allowed for a single tool result */
  toolResultTokenLimit: number;
  /** Maximum tokens allowed for a single sub-agent */
  subAgentTokenLimit: number;
  /** Maximum USD cost allowed per session (null = no limit) */
  costLimitUsd: number | null;
}

/**
 * Result of a budget check.
 */
export interface BudgetCheckResult {
  /** Whether the operation is allowed within budget */
  allowed: boolean;
  /** Reason for denial (only set when allowed=false) */
  reason?: string;
  /** Snapshot of remaining budget */
  remaining: BudgetSnapshot;
}

/**
 * Snapshot of remaining budget at a point in time.
 */
export interface BudgetSnapshot {
  sessionTokensRemaining: number;
  turnTokensRemaining: number;
  costRemainingUsd: number | null;
}

/**
 * Default budget config with very high limits (effectively unlimited).
 */
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  sessionTokenLimit: Number.MAX_SAFE_INTEGER,
  turnTokenLimit: Number.MAX_SAFE_INTEGER,
  toolResultTokenLimit: Number.MAX_SAFE_INTEGER,
  subAgentTokenLimit: Number.MAX_SAFE_INTEGER,
  costLimitUsd: null,
};

/**
 * BudgetEnforcer tracks and enforces token and cost budgets.
 *
 * Usage:
 *   const enforcer = new BudgetEnforcer({ sessionTokenLimit: 1_000_000, ... });
 *   const check = enforcer.checkTurnBudget(estimatedTokens);
 *   if (!check.allowed) throw new KCError('budget_exceeded', check.reason!);
 *   // ... do work ...
 *   enforcer.recordUsage(actualTokens);
 */
export class BudgetEnforcer {
  private sessionTokens = 0;
  private turnTokens = 0;
  private sessionCostUsd = 0;
  private config: BudgetConfig;

  constructor(config: Partial<BudgetConfig> = {}) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  /**
   * Check whether a turn (LLM call) is within budget.
   * @param estimatedTokens - Estimated tokens for the upcoming turn
   * @returns BudgetCheckResult with allowed flag and remaining snapshot
   */
  checkTurnBudget(estimatedTokens: number): BudgetCheckResult {
    const remaining = this.getRemaining();

    // Check session limit
    if (this.sessionTokens + estimatedTokens > this.config.sessionTokenLimit) {
      return {
        allowed: false,
        reason: `Session token budget exceeded: ${this.sessionTokens} used + ${estimatedTokens} estimated > ${this.config.sessionTokenLimit} limit`,
        remaining,
      };
    }

    // Check turn limit
    if (this.turnTokens + estimatedTokens > this.config.turnTokenLimit) {
      return {
        allowed: false,
        reason: `Turn token budget exceeded: ${this.turnTokens} used + ${estimatedTokens} estimated > ${this.config.turnTokenLimit} limit`,
        remaining,
      };
    }

    // Check cost limit
    if (this.config.costLimitUsd !== null && this.sessionCostUsd >= this.config.costLimitUsd) {
      return {
        allowed: false,
        reason: `Session cost budget exceeded: $${this.sessionCostUsd.toFixed(4)} >= $${this.config.costLimitUsd} limit`,
        remaining,
      };
    }

    return { allowed: true, remaining };
  }

  /**
   * Check whether a tool result is within the tool result token limit.
   * @param result - The tool result to check
   * @returns BudgetCheckResult with allowed flag and remaining snapshot
   */
  checkToolResultBudget(result: ToolResult): BudgetCheckResult {
    const remaining = this.getRemaining();
    const outputText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    const resultTokens = estimateToolResultTokens(outputText);

    if (resultTokens > this.config.toolResultTokenLimit) {
      return {
        allowed: false,
        reason: `Tool result token budget exceeded: ${resultTokens} tokens > ${this.config.toolResultTokenLimit} limit`,
        remaining,
      };
    }

    // Also check session-level budget
    if (this.sessionTokens + resultTokens > this.config.sessionTokenLimit) {
      return {
        allowed: false,
        reason: `Session token budget exceeded by tool result: ${this.sessionTokens} used + ${resultTokens} result > ${this.config.sessionTokenLimit} limit`,
        remaining,
      };
    }

    return { allowed: true, remaining };
  }

  /**
   * Check whether a sub-agent spawn is within the sub-agent token budget.
   * @param estimatedTokens - Estimated tokens the sub-agent might use
   * @returns BudgetCheckResult with allowed flag and remaining snapshot
   */
  checkSubAgentBudget(estimatedTokens: number): BudgetCheckResult {
    const remaining = this.getRemaining();

    // Check sub-agent limit
    if (estimatedTokens > this.config.subAgentTokenLimit) {
      return {
        allowed: false,
        reason: `Sub-agent token budget exceeded: ${estimatedTokens} estimated > ${this.config.subAgentTokenLimit} limit`,
        remaining,
      };
    }

    // Check session-level budget
    if (this.sessionTokens + estimatedTokens > this.config.sessionTokenLimit) {
      return {
        allowed: false,
        reason: `Session token budget exceeded by sub-agent: ${this.sessionTokens} used + ${estimatedTokens} estimated > ${this.config.sessionTokenLimit} limit`,
        remaining,
      };
    }

    return { allowed: true, remaining };
  }

  /**
   * Record actual token (and optionally cost) usage after an operation.
   * Call this after a successful LLM call or tool execution.
   */
  recordUsage(tokens: number, costUsd?: number): void {
    this.sessionTokens += tokens;
    this.turnTokens += tokens;
    if (costUsd !== undefined) {
      this.sessionCostUsd += costUsd;
    }
  }

  /**
   * Reset turn-level counters. Call at the start of each new turn.
   */
  resetTurn(): void {
    this.turnTokens = 0;
  }

  /**
   * Get a snapshot of remaining budget.
   */
  getRemaining(): BudgetSnapshot {
    return {
      sessionTokensRemaining: Math.max(0, this.config.sessionTokenLimit - this.sessionTokens),
      turnTokensRemaining: Math.max(0, this.config.turnTokenLimit - this.turnTokens),
      costRemainingUsd: this.config.costLimitUsd !== null
        ? Math.max(0, this.config.costLimitUsd - this.sessionCostUsd)
        : null,
    };
  }

  /**
   * Get current session usage totals.
   */
  getSessionUsage(): { tokens: number; costUsd: number } {
    return {
      tokens: this.sessionTokens,
      costUsd: this.sessionCostUsd,
    };
  }
}

/**
 * Create a KCError for budget exceeded scenarios.
 * Convenience factory for consistent error creation.
 */
export function createBudgetExceededError(reason: string, context?: Record<string, unknown>): KCError {
  return new KCError('budget_exceeded', reason, context);
}
