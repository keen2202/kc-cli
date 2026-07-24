// Shared event types - single source of truth for agent and orchestrator events
// Single source of truth for agent and orchestrator event types

import type { ChatMessage, ToolCall, ToolResult, PlanningFinding } from '../query/protocol';
import type { BudgetSnapshot } from '../services/budget';
import type { AcceptanceReport } from '../query/completion-report';

/**
 * Token usage tracking
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * Sub-agent result
 */
export interface SubAgentResult {
  agentId: string;
  name: string;
  success: boolean;
  output: string;
  toolUseCount: number;
  totalTokensUsed: number;
  duration: number;
  error?: string;
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
