// State machine types for the agent system

import type { ChatMessage, ToolCall, ToolResult } from '../types/message';
import type { PermissionMode } from '../types/permissions';
import type { LLMProvider } from '../api';

/**
 * Agent state names - represents the current phase of the query loop
 */
export type AgentStateName =
  | 'idle'
  | 'compacting'
  | 'streaming'
  | 'deciding'
  | 'executing'
  | 'completed'
  | 'error';

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

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

  // Compaction
  compactFailureCount: number;
  lastCompactedAt: number | null;

  // Tool execution (observable parallel state)
  activeToolExecutions: Map<string, ToolExecutionState>;

  // Timestamps
  createdAt: number;
  lastActivityAt: number;
}

import type { MultiAgentEvent } from '../types/orchestrator';

export type { SubAgentResult, MultiAgentEvent } from '../types/orchestrator';

/**
 * Rich agent events - discriminated union for type-safe event handling
 * Includes both single-agent and multi-agent events
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
  | { type: 'agent:complete'; timestamp: number }
  | { type: 'agent:tool_hint'; toolName: string; hint: string; timestamp: number }
  | MultiAgentEvent;

/**
 * State transition validation rules
 * Defines which states can transition to which other states
 */
export const VALID_TRANSITIONS: Record<AgentStateName, AgentStateName[]> = {
  idle: ['compacting', 'error'],
  compacting: ['streaming', 'error'],
  streaming: ['deciding', 'error'],
  deciding: ['executing', 'completed', 'error'],
  executing: ['streaming', 'completed', 'error'],
  completed: ['idle', 'error'],
  error: ['idle', 'error'],
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
