// Multi-agent coordination types

import type { ToolName } from '../tools/protocol.js';
import type { PermissionMode } from '../permissions/protocol.js';
import type { AgentEvent } from '../state/types.js';
import type { StreamEvent } from '../query/protocol.js';

/**
 * QueryEngine interface - avoids circular import while providing type safety
 */
export interface QueryEngineLike {
  submitMessage(message: string): AsyncGenerator<StreamEvent | AgentEvent>;
  abort(reason?: string): void;
  isAborted(): boolean;
}

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
  queryEngine: QueryEngineLike | null; // QueryEngine instance (circular import avoided)
  abortController: AbortController;
  startedAt: number;
  completedAt?: number;
  toolUseCount: number;
  totalTokensUsed: number;
  error?: Error;
}

export type { SubAgentResult, MultiAgentEvent } from '../state/events.js';

// Re-import for local use
import type { SubAgentResult } from '../state/events.js';

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
  queryEngine: QueryEngineLike | null; // QueryEngine instance
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
