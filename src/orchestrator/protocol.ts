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
  /** Controller checkpoint questions that must be answered explicitly. */
  checkpoints?: string[];
  /**
   * Zero-trust report policy for this sub-agent. Omit to keep the legacy
   * (pre-integrity) path: no report validation and no follow-up turns.
   */
  reportPolicy?: ReportPolicy;
}

// ─── Agent Report Integrity (RI-SPEC v1.0) ──────────────────────────────

/** A completed command reported by a sub-agent, with optional verbatim evidence. */
export interface CommandRunClaim {
  command: string;
  exitCode: number;
  /** Exact output line used as evidence for numeric claims. */
  evidenceLine?: string;
}

/**
 * Structured completion claim. Numeric conclusions must cite an
 * `evidenceLine`; process obligations must cite where they came from.
 */
export interface CompletionClaim {
  filesCreated: string[];
  filesModified: string[];
  commands: CommandRunClaim[];
  /** Each process obligation → source (message index / section id). */
  obligationCitations: string[];
}

/** Sections the validator must find in a completion report. */
export interface RequiredSections {
  /** Canonical required section names. */
  requiredSections?: string[];
  /** Alias used by callers that build the object from a named list. */
  sections?: string[];
  /** Alias matching the spec signature field name. */
  required?: string[];
  /** Controller checkpoint questions that must be answered explicitly. */
  checkpoints?: string[];
}

/** Report validation rule identifiers (R1–R5 in RI-SPEC §3). */
export type ReportFindingRule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5';

export type ReportFindingSeverity = 'blocker' | 'warning';

/** A deterministic finding produced by `validateReport()`. */
export interface ReportFinding {
  rule: ReportFindingRule;
  severity: ReportFindingSeverity;
  /** Stable machine-readable code, e.g. `missing_section`. */
  code: string;
  /** Human-readable summary shown to the controller. */
  message: string;
  /** Present for R1/R2 findings about a specific required section. */
  section?: string;
  /** Raw detail (claimed value, evidence excerpt, path, …). */
  detail?: string;
  /** R2 sets this when a numeric claim lacks verifiable evidence. */
  unsubstantiated?: boolean;
}

/** Runtime gate policy for a sub-agent completion report. */
export interface ReportPolicy {
  /** Required section names (R1). */
  requiredSections: string[];
  /** Follow-up budget; default 1, hard-capped at 2 by the orchestrator. */
  maxFollowUps?: number;
}

/**
 * Optional metadata attached to `SubAgentResult`. All fields are optional so
 * legacy consumers and producers keep compiling.
 */
export interface SubAgentReportMeta {
  /** In-memory execution trace captured in the sub-agent's AsyncLocalStorage scope. */
  executionTrace?: import('../services/execution-env.js').ExecutionTrace;
  /** Alias for callers that carry the trace as `meta.trace`. */
  trace?: import('../services/execution-env.js').ExecutionTrace;
  /** Findings produced by `validateReport()` for this result. */
  reportFindings?: ReportFinding[];
  /** True when blocker findings survived the follow-up budget. */
  unresolved?: boolean;
  /** Number of report follow-up turns already consumed. */
  followUpsUsed?: number;
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
  /** All report-integrity findings collected from gated sub-agent results. */
  findings?: ReportFinding[];
  /** Alias for `findings` used by callers wired to `SubAgentResult.meta`. */
  reportFindings?: ReportFinding[];
  /** Agent IDs whose report still has unresolved blocker findings. */
  unresolvedAgents?: string[];
  /** Convenience flag: true when at least one agent is unresolved. */
  unresolved?: boolean;
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
 * Per-tool restriction for an agent profile.
 * Used to enforce capability limits (e.g., read-only Bash for researcher).
 */
export interface AgentToolRestriction {
  toolName: string;
  restrictions: Record<string, unknown>;
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
  /** Per-tool capability restrictions enforced at execution time */
  toolRestrictions?: AgentToolRestriction[];
  defaultMaxTurns?: number;
  defaultTimeoutSeconds?: number;
}
