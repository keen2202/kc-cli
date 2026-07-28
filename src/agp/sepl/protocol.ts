/**
 * Self-Evolution Protocol Layer (SEPL) — Type System
 *
 * Implements the formal SEPL operator algebra from the Autogenesis paper
 * (arXiv:2604.15034, §4).
 *
 * Core pipeline:  Reflect → Select → Improve → Evaluate → Commit
 * Each operator is a stateful, composable transformation over the
 * evolvable subspace Θ ⊂ RSPL.
 */

import type { ResourceType, ResourceRegistrationRecord } from '../protocol';

// ─── Failure Signatures (harness-evolution T3 / H3) ─────────────────────────

/**
 * Deterministic failure mechanism inferred from the trace sequence.
 * Rules are applied in a fixed priority order so the same trace always
 * yields the same mechanism.
 */
export type FailureMechanism =
  | 'retry_loop'             // Same call (source + input) failed consecutively >= 2 times
  | 'missing_artifact'       // ENOENT-class: a required file/resource does not exist
  | 'exploration_stall'      // Long read-only streak (or runtime-control break) before failure
  | 'schema_invalid'         // Input/output failed schema or syntax validation
  | 'timeout_unbounded'      // Operation exceeded its time budget
  | 'permission_blocked'     // Permission/ACL denied the operation
  | 'env_missing_dependency' // Missing command/module in the execution environment
  | 'unknown';

/** Causal role of a failure relative to the terminal (last) failure. */
export type FailureCausalStatus = 'direct' | 'contributing' | 'incidental';

/**
 * Three-part structured failure signature. Replaces raw error-message
 * string counting as the clustering key.
 */
export interface FailureSignature {
  /** Stable cause identifier — reuses KCError ErrorCode / classifyToolError context prefixes */
  terminalCause: string;
  /** Causal role relative to the terminal failure of the trace */
  causalStatus: FailureCausalStatus;
  /** Deterministically inferred failure mechanism */
  mechanism: FailureMechanism;
}

/** Minimal reference to a trace event backing an evidence cluster. */
export interface EvidenceEventRef {
  id: string;
  source: string;
  message: string;
  timestamp: number;
}

/**
 * A cluster of failures sharing the exact same signature.
 * Intentionally contains NO prescriptions (no fix direction, no repair
 * suggestion) — evaluator/optimizer separation is enforced by type shape.
 */
export interface EvidenceCluster {
  signature: FailureSignature;
  /** Number of failure events in this cluster */
  count: number;
  /** Up to 3 minimal event references */
  representativeEvents: EvidenceEventRef[];
  /** Up to 5 de-duplicated symptom messages */
  sharedSymptoms: string[];
}

/**
 * Evidence bundle produced by TraceManager.buildEvidenceBundle().
 * Deterministic: the same trace sequence always yields the same bundle
 * (modulo generatedAt).
 */
export interface EvidenceBundle {
  clusters: EvidenceCluster[];
  /** Total failure events considered */
  totalFailures: number;
  /** Bundle creation timestamp */
  generatedAt: number;
}

// ─── Acceptance Gate (harness-evolution T4 / H4) ────────────────────────

/** Evaluation splits — fixed before a run, identical across candidates. */
export type EvalSplit = 'held_in' | 'held_out';

/** One repeated run of a split: pass counts over a fixed denominator. */
export interface SplitRepeat {
  /** Repeat identifier (0-based index) */
  repeat: number;
  /** Number of passing tasks in this repeat */
  passed: number;
  /** Total tasks in this repeat (the denominator) */
  total: number;
}

/** Result of evaluating one split (input shape for the acceptance gate). */
export interface SplitResult {
  split: EvalSplit;
  repeats: SplitRepeat[];
}

/** Per-split detail in a gate decision. */
export interface GateSplitDetail {
  split: EvalSplit;
  baselinePassRate: number;
  candidatePassRate: number;
  /** candidatePassRate - baselinePassRate */
  delta: number;
}

/**
 * Versioned acceptance-gate decision contract, persisted to
 * `.kc-cli/audit/` for lineage tracking.
 */
export interface GateDecision {
  format: 'kc.acceptance_gate.v1';
  /** The acceptance rule, verbatim */
  rule: string;
  splits: GateSplitDetail[];
  decision: 'accept' | 'reject';
  reason: string;
  /** Decision timestamp (ms since epoch) */
  evaluatedAt: number;
}

/** Acceptance gate configuration (off by default). */
export interface AcceptanceGateConfig {
  /** Master switch — when false, SEPL behavior is unchanged */
  enabled: boolean;
  /** Fixed repeats per split (default 2) */
  repeats?: number;
  /** Directory for persisted gate decisions (default `.kc-cli/audit/`) */
  auditDir?: string;
}

// ─── Evaluator Backend (T5 / H5) ─────────────────────────────────────────────

/** Options for a single evaluator backend run. */
export interface EvaluatorBackendOptions {
  /** Fixed repeats per split (defaults to the eval-set setting, then 2) */
  repeats?: number;
  /** Per-task execution timeout in milliseconds */
  timeoutMs?: number;
  /** Abort signal propagated to task executions */
  signal?: AbortSignal;
}

/**
 * A real evaluation backend that scores a candidate state on a fixed eval
 * split by executing actual verification tasks. Output aligns with the T4
 * acceptance-gate input (`SplitResult`), so gate and evaluator compose
 * without adapters.
 */
export interface EvaluatorBackend {
  /** Backend identifier (e.g. "vitest") */
  readonly name: string;
  evaluate(
    candidateState: EvolvableState,
    split: EvalSplit,
    opts?: EvaluatorBackendOptions
  ): Promise<SplitResult>;
}

/**
 * Placeholder for the SWE-bench-backed evaluator bridging SEPL to the
 * QueryEngine benchmark pipeline (`query/protocol.ts` v3.3). Interface
 * reserved as the integration point; intentionally not implemented yet.
 */
export interface SweBenchEvaluatorBackend extends EvaluatorBackend {
  readonly name: 'swe-bench';
  /** Benchmark subset identifier (e.g. "swe-bench-lite") */
  readonly subset: string;
}

/**
 * Evaluation-set definition loaded from `.kc-cli/evolution-eval.json`.
 * Held-in / held-out task lists are fixed before a run and identical
 * across all candidates (see `.kc-cli/evolution-eval-example.json`).
 */
export interface EvolutionEvalConfig {
  format: 'kc.evolution_eval.v1';
  /** Held-in verification tasks (e.g. vitest file paths) */
  heldIn: string[];
  /** Held-out verification tasks; must be disjoint from heldIn */
  heldOut: string[];
  /** Fixed repeats per split (default 2) */
  repeats?: number;
}

// ─── LLM Proposer (T6 / M1) ─────────────────────────────────────────────────────

/**
 * Mandatory audit quadruple attached to every LLM proposal. Proposals
 * missing any field are rejected before entering the pipeline.
 */
export interface ProposalAudit {
  /** Which clustered failure pattern this edit targets */
  targetFailurePattern: string;
  /** The single instruction surface / resource being edited */
  editedSurface: string;
  /** Expected effect of the edit on the target pattern */
  expectedEffect: string;
  /** Self-assessed regression risk */
  regressionRisk: string;
}

/** One bounded candidate edit produced by the LLM proposer. */
export interface ProposalCandidate {
  /** Proposed new value for the target variable */
  proposedValue: string;
  /** Mandatory audit quadruple */
  audit: ProposalAudit;
}

// ─── Auxiliary Spaces ────────────────────────────────────────────────────────

/**
 * Trace space Z — structured execution traces from TraceManager.
 * Input to the Reflect operator.
 */
export interface TraceSpace {
  /** Raw execution summary data */
  executionSummary: {
    totalEvents: number;
    errorCount: number;
    failurePatterns: Map<string, number>;
    averageLatencyMs: number;
    toolFailures: Array<{ name: string; errorMessage?: string; count: number }>;
    llmIssues: Array<{ model: string; errorMessage?: string }>;
  };
  /** Session ID this trace covers */
  sessionId?: string;
  /**
   * Structured failure evidence (harness-evolution T3). Optional for
   * backward compatibility — when absent, Reflect falls back to the
   * legacy string-count heuristics.
   */
  evidence?: EvidenceBundle;
}

/**
 * Hypothesis space H — causal hypotheses generated by Reflect.
 * Output of Reflect, input to Select.
 */
export interface Hypothesis {
  /** Unique hypothesis ID */
  id: string;
  /** Human-readable description of the root cause */
  description: string;
  /** Confidence score [0, 1] */
  confidence: number;
  /** Which resource types are implicated */
  implicatedTypes: ResourceType[];
  /** Specific resource names suspected */
  suspectedResources: string[];
  /** Suggested fix direction */
  fixDirection: 'prompt_tune' | 'tool_replace' | 'config_change' | 'agent_rewire' | 'memory_update';
  /** Supporting evidence from traces */
  evidence: string[];
}

export interface HypothesisSpace {
  hypotheses: Hypothesis[];
  /** Generation timestamp */
  generatedAt: number;
  /** Reflect operator iteration */
  iteration: number;
}

/**
 * Modification space D — proposed modifications from Select.
 * Output of Select, input to Improve.
 */
export interface Modification {
  /** Modification ID */
  id: string;
  /** Source hypothesis ID */
  hypothesisId: string;
  /** Target resource qualified name "type:name" */
  targetResource: string;
  /** Target resource type */
  resourceType: ResourceType;
  /** What to change */
  changeType: 'variable_update' | 'description_update' | 'metadata_update' | 'template_rewrite';
  /** The proposed new value (opaque until applied) */
  proposedValue: unknown;
  /** Estimated impact score [0, 1] */
  estimatedImpact: number;
  /** Risk level */
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ModificationSpace {
  modifications: Modification[];
  /** Selected hypothesis ID */
  sourceHypothesisId: string;
}

/**
 * Objective specification G — what "better" means.
 * Used by Evaluate to score candidates.
 */
export interface ObjectiveSpec {
  /** Primary metric name (e.g., "success_rate", "latency_p95") */
  primaryMetric: string;
  /** Minimum acceptable value for primary metric */
  minimumThreshold: number;
  /** Secondary metrics to optimize */
  secondaryMetrics?: Array<{ name: string; weight: number }>;
  /** Safety constraints that MUST hold */
  safetyConstraints: Array<{
    name: string;
    check: (state: unknown) => boolean;
  }>;
}

/**
 * Evaluation space S — scores and decisions from Evaluate.
 * Output of Evaluate, input to Commit.
 */
export interface EvaluationResult {
  /** Whether the candidate passed evaluation */
  accepted: boolean;
  /** Primary metric score */
  primaryScore: number;
  /** All metric scores */
  metricScores: Record<string, number>;
  /** Whether all safety constraints passed */
  safetyPassed: boolean;
  /** Which constraints failed (if any) */
  failedConstraints: string[];
  /** Improvement over baseline (positive = better) */
  improvementDelta: number;
  /** Human-readable evaluation summary */
  summary: string;
}

export interface EvaluationSpace {
  results: EvaluationResult[];
  /** Baseline metrics before evolution */
  baseline: Record<string, number>;
  /** Best candidate index (-1 if none accepted) */
  bestCandidateIndex: number;
}

// ─── Evolvable Variable ──────────────────────────────────────────────────────

/**
 * An evolvable variable is a parameter within a resource that SEPL
 * is allowed to modify (g_v = 1 in the trainable subspace Θ).
 */
export interface EvolvableVariable {
  /** Owning resource qualified name "type:name" */
  resourceId: string;
  /** Resource type */
  resourceType: ResourceType;
  /** Variable name within the resource */
  variableName: string;
  /** Whether this variable is learnable (g_v = 1) */
  learnability: 0 | 1;
  /** Current value */
  currentValue: unknown;
  /** Value type hint */
  valueType: 'string' | 'number' | 'boolean' | 'object' | 'template';
  /** Optional bounds */
  bounds?: { min?: number; max?: number };
  /** Optional list of allowed values */
  allowedValues?: unknown[];
}

/**
 * The evolvable state is the collection of all evolvable variables.
 */
export interface EvolvableState {
  /** All variables keyed by "resourceId:variableName" */
  variables: Map<string, EvolvableVariable>;
  /** IDs of trainable variables (g_v = 1) */
  trainableSubset: string[];
}

// ─── SEPL Operator Interface ─────────────────────────────────────────────────

/**
 * A SEPL operator is a composable, stateful transformation.
 *
 * Formal definition: O_i : (S, I) → (S', O)
 * where S is the evolvable state, I is operator-specific input,
 * S' is the updated state, and O is operator-specific output.
 */
export interface SEPLOperator<Input, Output> {
  /** Operator name */
  readonly name: string;
  /** Execute the operator */
  execute(state: EvolvableState, input: Input): Promise<SEPLOutput<Output>>;
}

/**
 * Output of a SEPL operator execution.
 */
export interface SEPLOutput<T> {
  /** Updated evolvable state */
  state: EvolvableState;
  /** Operator-specific output */
  output: T;
  /** Whether the operator succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Execution duration in ms */
  durationMs: number;
}

// ─── Evolution Cycle State ───────────────────────────────────────────────────

/**
 * Complete state of one evolution cycle.
 * Passed through the operator pipeline.
 */
export interface EvolutionCycleState {
  /** Cycle iteration number */
  iteration: number;
  /** Current evolvable state */
  evolvableState: EvolvableState;
  /** Trace input */
  traces: TraceSpace | null;
  /** Generated hypotheses */
  hypotheses: HypothesisSpace | null;
  /** Proposed modifications */
  modifications: ModificationSpace | null;
  /** Evaluation results */
  evaluation: EvaluationSpace | null;
  /** Whether changes were committed */
  committed: boolean;
  /** Cycle start timestamp */
  startedAt: number;
  /** Cycle end timestamp */
  endedAt?: number;
  /** Errors encountered during the cycle */
  errors: string[];
}

/**
 * Result of a complete evolution cycle.
 */
export interface EvolutionCycleResult {
  /** Cycle iteration */
  iteration: number;
  /** Whether any changes were committed */
  committed: boolean;
  /** Committed resource names (if any) */
  committedResources: string[];
  /** Evaluation summary */
  evaluationSummary?: string;
  /** Total cycle duration in ms */
  durationMs: number;
  /** Rollback performed */
  rolledBack: boolean;
}

// ─── Evolution Configuration ─────────────────────────────────────────────────

/**
 * Configuration for the SEPL evolution loop.
 */
export interface SEPLConfig {
  /** Maximum iterations per evolution run */
  maxIterations: number;
  /** Target resource qualified names (empty = all evolvable) */
  targetResources: string[];
  /** Objective specification */
  objective: ObjectiveSpec;
  /** Auto-rollback on evaluation failure */
  autoRollback: boolean;
  /** LLM model for reflection */
  reflectionModel?: string;
  /** Whether to record detailed audit trail */
  auditTrail: boolean;
  /** Timeout per operator (ms) */
  operatorTimeoutMs: number;
  /**
   * Non-regressive acceptance gate (harness-evolution T4). Optional for
   * backward compatibility; disabled by default.
   */
  acceptanceGate?: AcceptanceGateConfig;
}

export const DEFAULT_SEPL_CONFIG: SEPLConfig = {
  maxIterations: 3,
  targetResources: [],
  objective: {
    primaryMetric: 'success_rate',
    minimumThreshold: 0.8,
    safetyConstraints: [],
  },
  autoRollback: true,
  auditTrail: true,
  operatorTimeoutMs: 30000,
  acceptanceGate: { enabled: false, repeats: 2 },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

let hypothesisCounter = 0;
export function generateHypothesisId(): string {
  return `hyp_${Date.now().toString(36)}_${(hypothesisCounter++).toString(36)}`;
}

let modificationCounter = 0;
export function generateModificationId(): string {
  return `mod_${Date.now().toString(36)}_${(modificationCounter++).toString(36)}`;
}

/**
 * Create an empty EvolvableState.
 */
export function createEmptyEvolvableState(): EvolvableState {
  return { variables: new Map(), trainableSubset: [] };
}

/**
 * Build EvolvableState from a set of registered resources.
 */
export function buildEvolvableState(
  records: Array<{ record: ResourceRegistrationRecord; resourceType: ResourceType }>
): EvolvableState {
  const variables = new Map<string, EvolvableVariable>();
  const trainableSubset: string[] = [];

  for (const { record, resourceType } of records) {
    if (record.entity.evolvability !== 1) continue;

    const resourceId = `${resourceType}:${record.entity.name}`;

    // Extract evolvable variables from metadata
    const metadata = record.entity.metadata as Record<string, unknown>;
    for (const [key, value] of Object.entries(metadata)) {
      if (value === undefined || value === null) continue;
      const varKey = `${resourceId}:${key}`;
      const valueType = inferValueType(value);
      const variable: EvolvableVariable = {
        resourceId,
        resourceType,
        variableName: key,
        learnability: 1,
        currentValue: value,
        valueType,
      };
      variables.set(varKey, variable);
      trainableSubset.push(varKey);
    }

    // Description is always evolvable for evolvable resources
    const descKey = `${resourceId}:description`;
    variables.set(descKey, {
      resourceId,
      resourceType,
      variableName: 'description',
      learnability: 1,
      currentValue: record.entity.description,
      valueType: 'string',
    });
    trainableSubset.push(descKey);
  }

  return { variables, trainableSubset };
}

function inferValueType(value: unknown): EvolvableVariable['valueType'] {
  if (typeof value === 'string') {
    // Heuristic: long strings with placeholders are templates
    if (value.length > 100 && (value.includes('{{') || value.includes('${'))) return 'template';
    return 'string';
  }
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}
