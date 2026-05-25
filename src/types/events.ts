// Shared event types - single source of truth for agent and orchestrator events
// This breaks the circular dependency between state/types and types/orchestrator

import type { ChatMessage, ToolCall, ToolResult } from './message';

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
  | { type: 'agent:complete'; timestamp: number }
  | { type: 'agent:tool_hint'; toolName: string; hint: string; timestamp: number }
  | MultiAgentEvent;
