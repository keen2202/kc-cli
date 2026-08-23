// State machine types for the agent system

import type { ChatMessage, ToolCall, ToolResult, PlanningFinding } from '../query/protocol';
import type { PermissionMode } from '../permissions/protocol';
import type { LLMProvider } from '../api';
import type { BudgetSnapshot } from '../services/budget';
import type { AcceptanceReport } from '../query/completion-report';
// T18/M4: AgentEvent + MultiAgentEvent now LIVE here (single protocol home for
// state-machine event contracts). TokenUsage/SubAgentResult remain in
// ./events; the type-only import below is one direction of an intentional,
// erased-at-runtime cycle (events.ts re-exports the event types back).
import type { TokenUsage, SubAgentResult } from './events';


/**
 * Agent state names - represents the current phase of the query loop
 */
export type AgentStateName =
  | 'idle'
  | 'planning'      // NEW: strategic planning phase before code changes
  | 'compacting'
  | 'streaming'
  | 'deciding'
  | 'executing'
  | 'completed'
  | 'evolving'
  | 'error';

/**
 * Tool execution state tracking
 */
export interface ToolExecutionState {
  id: string;
  toolCall: ToolCall;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'killed';
  startedAt?: number;
  completedAt?: number;
  result?: ToolResult;
  error?: Error;
}

/**
 * Complete immutable agent state snapshot
 */
export interface AgentState {
  // Core
  cwd: string;
  sessionId: string;
  verbose: boolean;
  printMode: boolean;
  bareMode: boolean;

  // API
  model: string;
  provider: LLMProvider;
  maxTokens: number;

  // Permissions
  permissionMode: PermissionMode;

  // Execution
  currentState: AgentStateName;
  turnCount: number;
  maxTurns: number;
  maxBudgetUsd: number | null;
  totalTokensUsed: number;

  // Budget tracking
  budgetUsed: {
    session: number;
    currentTurn: number;
    toolResults: number;
  };

  // Compaction
  compactFailureCount: number;
  lastCompactedAt: number | null;

  // Tool execution (observable parallel state)
  activeToolExecutions: Map<string, ToolExecutionState>;

  // Branching
  activeBranchId: string;

  // File modification tracking
  modifiedFiles?: string[];

  // Timestamps
  createdAt: number;
  lastActivityAt: number;

  // AGP Evolution state (optional)
  evolutionState?: {
    active: boolean;
    iteration: number;
    lastEvolutionAt?: number;
    committedChanges: number;
    rolledBackChanges: number;
  };
}

/**
 * State transition validation rules
 * Defines which states can transition to which other states
 */
export const VALID_TRANSITIONS: Record<AgentStateName, AgentStateName[]> = {
  idle: ['planning', 'compacting'],  // modified: added 'planning'
  planning: ['compacting', 'streaming', 'error'],  // NEW
  compacting: ['streaming', 'error'],
  streaming: ['deciding', 'compacting', 'error'],
  deciding: ['executing', 'completed', 'compacting', 'error'],
  executing: ['streaming', 'compacting', 'completed', 'error'],
  completed: ['evolving'],
  evolving: ['idle', 'completed', 'error'],
  error: ['idle'],
};

// Pre-built Set-based transitions for O(1) lookup (replaces Array.includes per validation)
const VALID_TRANSITION_SETS: Record<AgentStateName, Set<AgentStateName>> = Object.fromEntries(
  Object.entries(VALID_TRANSITIONS).map(([key, values]) => [key, new Set(values)])
) as Record<AgentStateName, Set<AgentStateName>>;

/**
 * Check if a state transition is valid
 */
export function isValidTransition(from: AgentStateName, to: AgentStateName): boolean {
  return VALID_TRANSITION_SETS[from]?.has(to) ?? false;
}

/**
 * Multi-agent events - discriminated union
 */
export type MultiAgentEvent =
  | {
      type: 'agent:subagent_spawned';
      agentId: string;
      name: string;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_progress';
      agentId: string;
      event: AgentEvent;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_completed';
      agentId: string;
      result: SubAgentResult;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_failed';
      agentId: string;
      error: string;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_timed_out';
      agentId: string;
      elapsed: number;
      timestamp: number;
    }
  | {
      type: 'agent:subagent_cancelled';
      agentId: string;
      timestamp: number;
    };

/**
 * Rich agent events - discriminated union for type-safe event handling
 * Includes both single-agent and multi-agent events
 *
 * T18/M4: canonical definition moved here from state/events.ts (which now
 * re-exports it for one version period).
 */
export type AgentEvent =
  | { type: 'agent:text_delta'; text: string; timestamp: number }
  | { type: 'agent:turn_complete'; message: ChatMessage; usage: TokenUsage; timestamp: number }
  | { type: 'agent:tool_started'; toolCall: ToolCall; timestamp: number }
  | { type: 'agent:tool_completed'; toolCall: ToolCall; result: ToolResult; timestamp: number }
  | { type: 'agent:tool_failed'; toolCall: ToolCall; error: Error; timestamp: number }
  | { type: 'agent:tool_permission_denied'; toolCall: ToolCall; reason: string; timestamp: number }
  | { type: 'agent:compact_micro'; tokensSaved: number; timestamp: number }
  | { type: 'agent:compact_full'; originalTokens: number; compactedTokens: number; timestamp: number }
  | { type: 'agent:error'; error: Error; recoverable: boolean; timestamp: number }
  | { type: 'agent:steered'; message: ChatMessage; timestamp: number }
  | { type: 'agent:complete'; timestamp: number; report?: AcceptanceReport }
  | { type: 'agent:tool_hint'; toolName: string; hint: string; timestamp: number }
  | { type: 'agent:thinking_delta'; thinking: string; timestamp: number }
  | { type: 'agent:cache_status'; hit: boolean; timestamp: number }
  // Planning events
  | { type: 'agent:planning_started'; timestamp: number }
  | { type: 'agent:planning_turn'; turn: number; timestamp: number }
  | { type: 'agent:planning_complete'; findings: PlanningFinding[]; timestamp: number }
  | { type: 'agent:budget_exceeded'; reason: string; remaining: BudgetSnapshot; timestamp: number }
  | MultiAgentEvent;
