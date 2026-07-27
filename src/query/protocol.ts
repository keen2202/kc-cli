// Message types for the conversation system

import type { ToolResult as ToolResultGeneric } from '../tools/protocol';

// Re-export ToolResult<string> for backward compatibility
// This is the ToolResult type used in message passing (string output)
export type ToolResult = ToolResultGeneric<string>;

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  id: string;
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

/**
 * ToolResult for message passing (string output)
 * Re-exports the unified ToolResult from tools.ts
 * toolCallId is required for message context, output is string for serialization
 */
export type ToolResultMessage = Omit<ToolResult, 'toolCallId' | 'output'> & {
  toolCallId: string;
  output: string;
};

export interface UserMessage extends Message {
  role: 'user';
  content: string;
}

export interface AssistantMessage extends Message {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface SystemMessage extends Message {
  role: 'system';
  content: string;
}

export interface ToolMessage extends Message {
  role: 'tool';
  toolResults: ToolResult[];
}

export type ChatMessage = UserMessage | AssistantMessage | SystemMessage | ToolMessage;

// Streaming events
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_use_start'; toolCall: ToolCall }
  | { type: 'tool_use_end'; toolCall: ToolCall; result: ToolResult }
  | { type: 'error'; error: Error }
  | { type: 'complete'; message: AssistantMessage };

// ─── Benchmark Optimization Types (v3.3) ─────────────────────────

/** Per-turn importance classification for smart compaction. */
export type TurnImportance = 'key_finding' | 'exploration' | 'failed_attempt';

/** Metadata attached to each conversation turn. */
export interface TurnTag {
  importance: TurnImportance;
  keywords: string[];
  filePaths: string[];
  testOutput?: string;
  applied: boolean;
}

/** A ChatMessage annotated with its TurnTag for compaction decisions. */
export interface MessageWithTag {
  message: ChatMessage;
  tag: TurnTag;
  turnIndex: number;
}

/** Structured finding from the planning phase. */
export interface PlanningFinding {
  hypothesis: string;
  relevantFiles: string[];
  testErrorSummary?: string;
  confidence: 'low' | 'medium' | 'high';
}

/** Configuration for the strategic planning phase. */
export interface PlanningPhaseConfig {
  enabled: boolean;
  maxTurns: number;
  exemptFromBudget: boolean;
}

/** Configuration for patch guarantee mechanism. */
export interface PatchGuaranteeConfig {
  enabled: boolean;
  maxZeroPatchRetries: number;
  maxVerificationRetries: number;
  verificationTimeout: number;
  testCommand: string;
  /** Enable pre-exit type-check verification (compile/type errors). */
  typeCheck: boolean;
  /** Type-check command; empty string means auto-detect from project language. */
  typeCheckCommand: string;
  /** Maximum retries when the type-check fails before allowing exit. */
  maxTypeCheckRetries: number;
  /**
   * T5 (H5): when true, a type-check that cannot be executed (spawn/toolchain
   * infrastructure failure, e.g. the runner is missing) blocks exit instead of
   * giving way, so the verification gap is surfaced rather than silently passed.
   * Defaults to false (give way on infra failure; genuine type errors always block).
   */
  typeCheckStrict?: boolean;
  /**
   * When true, exhausting zero-patch retries yields a non-recoverable
   * `model_no_patch` error (SWE-bench strict mode). Defaults to false:
   * interactive sessions complete normally, keeping the model's text answer.
   */
  failOnZeroPatch?: boolean;
}

/** Configuration for context window efficiency. */
export interface ContextEfficiencyConfig {
  enabled: boolean;
  importanceTagging: boolean;
  dedupCache: boolean;
  dedupCacheSize: number;
  failedAttemptMaxAge: number;
  explorationMaxAge: number;
}
