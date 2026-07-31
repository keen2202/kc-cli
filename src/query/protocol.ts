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

// ─── Runtime Control Policy (harness-evolution T2 / H2) ─────────────────

/**
 * Cross-turn runtime behavior policy ported from the Self-Harness golden
 * rules: retry discipline, exploration-loop breaking, and a total
 * tool-message cap with redirection. All interventions are OFF by default
 * (`enabled: false`) — zero behavior change when disabled.
 */
export interface RuntimeControlPolicy {
  enabled: boolean;
  /** Consecutive failures of the same (toolName, inputHash) call before intervention. */
  maxSameCallRetries: number;
  /** 'soft' injects a retry-discipline instruction next turn; 'hard' rejects the repeated call. */
  retryIntervention: 'soft' | 'hard';
  /** Consecutive read-only turns (no write/exec tools) before the loop breaker fires. */
  maxReadOnlyStreak: number;
  /** Total tool messages allowed before a redirect instruction is injected (0 = disabled). */
  maxTotalToolMessages: number;
  /** Custom redirect instruction for the tool-message cap (default provided by the engine). */
  redirectInstruction?: string;
}

/** A single runtime-control intervention, recorded for tracing (T3 consumption). */
export interface RuntimeControlIntervention {
  kind: 'retry_discipline' | 'exploration_break' | 'tool_message_redirect';
  mode: 'soft' | 'hard';
  toolName?: string;
  inputHash?: string;
  detail: string;
  timestamp: number;
}

// ─── Engine Configuration ─────────────────────────────────────────────

/** QueryEngine construction options (moved here from QueryEngine.ts, 4e). */
export interface QueryEngineConfig {
  model: string;
  provider: import('../api').LLMProvider;
  apiKey?: string;
  apiBaseUrl?: string;
  maxTurns: number;
  maxBudgetUsd: number | null;
  systemPrompt?: string;
  contextWindow?: number;
  maxMessages?: number;
  memory?: import('../memory/integration').MemoryIntegrationConfig;
  permissionRules?: {
    deny?: string[];
    ask?: string[];
    allow?: string[];
  };
  /** AGP Evolution hook — called after query completion if evolution is enabled */
  evolution?: {
    enabled: boolean;
    onEvolve?: (sessionId: string) => Promise<void>;
  };
  /** Auto-extend turn budget when active progress is detected */
  autoExtendTurns?: boolean;
  /** Hard ceiling for auto-extended turns; 0 or negative = unbounded (engine-local default 100) */
  maxTurnsCeiling?: number;
  /** Minimum turns before agent is allowed to exit (prevents early abandonment) */
  minTurns?: number;
  /** Auto-commit interval in turns (0 = disabled; engine-local default 0, production default flows from config) */
  autoCommitInterval?: number;

  /** Context window efficiency configuration (Area 3) */
  contextEfficiency?: ContextEfficiencyConfig;

  /** Strategic planning phase configuration (Area 1) */
  planningPhase?: PlanningPhaseConfig;

  /** Patch guarantee configuration (Area 2) */
  patchGuarantee?: PatchGuaranteeConfig;

  /** Sandbox failIfNoSandbox — passed through to SandboxManager */
  sandboxFailIfNoSandbox?: boolean;

  /**
   * T1 (H1): Fail-safe policy for 'ask' permission decisions in non-interactive
   * contexts (no UI approval handler). Default 'deny'. 'allow'/'proceed' require
   * explicit opt-in (config or CLI --dangerously-skip-permissions).
   */
  noninteractiveAskPolicy?: 'deny' | 'allow' | 'proceed';

  /**
   * harness-evolution T1 (H1): conditional instruction-surface injection.
   * When enabled, bootstrap/failure-recovery surfaces are appended as the
   * final system segment based on runtime predicates. Default off.
   */
    promptSurfaces?: {
    conditionalInjection?: boolean;
  };

  /**
   * harness-evolution T2 (H2): cross-turn runtime control policy (retry
   * discipline, exploration-loop breaking, tool-message cap). Default off.
   */
    runtimeControl?: Partial<RuntimeControlPolicy>;
}
