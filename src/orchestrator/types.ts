// Multi-agent coordination types

import type { ToolName, ToolDefinition, ToolUseContext } from '../types/tools';
import type { PermissionMode, PermissionContext } from '../types/permissions';
import type { AgentEvent, TokenUsage } from '../state/types';

/**
 * Sub-agent identity
 */
export interface SubAgentIdentity {
  agentId: string; // Format: "name@teamName"
  name: string; // Human-readable name
  team: string; // Team name
  parentId: string | null; // Parent agent ID
  color?: string; // UI display color
}

/**
 * Sub-agent spawn configuration
 */
export interface SubAgentSpawnConfig {
  name: string;
  prompt: string; // Task instruction
  systemPrompt?: string; // Optional system prompt
  systemPromptMode: 'default' | 'replace' | 'append';
  tools?: ToolName[]; // Allowed tool whitelist (default: inherit all)
  deniedTools?: ToolName[]; // Explicitly denied tools
  maxTurns?: number; // Max turns (default: 15)
  timeoutSeconds?: number; // Timeout in seconds (default: 300)
  tokenBudget?: number; // Token budget
  model?: string; // Model override
  permissions?: PermissionMode; // Permission mode (cannot exceed parent)
  cwd?: string; // Working directory
}

/**
 * Sub-agent status
 */
export type SubAgentStatus =
  | 'spawning'
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

/**
 * Sub-agent runtime information
 */
export interface SubAgentRuntime {
  identity: SubAgentIdentity;
  status: SubAgentStatus;
  config: SubAgentSpawnConfig;
  queryEngine: any; // QueryEngine instance (circular import avoided)
  abortController: AbortController;
  startedAt: number;
  completedAt?: number;
  toolUseCount: number;
  totalTokensUsed: number;
  error?: Error;
}

/**
 * Sub-agent result
 */
export interface SubAgentResult {
  agentId: string;
  name: string;
  success: boolean;
  output: string; // Formatted result text
  toolUseCount: number;
  totalTokensUsed: number;
  duration: number; // milliseconds
  error?: string;
}

/**
 * Aggregated result from multiple sub-agents
 */
export interface AggregatedResult {
  results: SubAgentResult[];
  totalDuration: number;
  totalTokensUsed: number;
  totalToolUses: number;
  summary: string; // Natural language summary for LLM
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
 * Sub-agent error types
 */
export type SubAgentError =
  | { type: 'timeout'; elapsed: number; partialOutput: string }
  | { type: 'llm_error'; message: string }
  | { type: 'tool_error'; toolName: string; message: string }
  | { type: 'permission_denied'; toolName: string }
  | { type: 'max_turns_exceeded'; turns: number }
  | { type: 'cancelled'; reason: string }
  | { type: 'unexpected'; error: Error };

/**
 * Spawn result
 */
export interface SpawnResult {
  agentId: string;
  success: boolean;
  error?: string;
  queryEngine: any; // QueryEngine instance
}

/**
 * Sub-agent message
 */
export interface SubAgentMessage {
  type: 'user_message' | 'shutdown' | 'permission_request' | 'permission_response';
  from: string;
  payload: Record<string, unknown>;
}

/**
 * Agent definition for pre-defined agent types
 */
export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt?: string;
  allowedTools?: ToolName[];
  deniedTools?: ToolName[];
  defaultMaxTurns?: number;
  defaultTimeoutSeconds?: number;
}
