/**
 * SEPL Reflect Operator (ρ)
 *
 * Analyzes execution traces to identify failure patterns and generate
 * causal hypotheses about what went wrong and what could be improved.
 *
 * ρ : (S, Z) → (S, H)
 * Input: TraceSpace (execution traces)
 * Output: HypothesisSpace (causal hypotheses)
 *
 * Corresponds to the paper's Reflect operator (§4.1).
 */

import type { TraceManager } from '../trace-manager';
import type {
  SEPLOperator,
  SEPLOutput,
  EvolvableState,
  TraceSpace,
  HypothesisSpace,
  Hypothesis,
  EvidenceCluster,
  FailureMechanism,
} from './protocol';
import { generateHypothesisId } from './protocol';
import type { ResourceType } from '../protocol';

// ─── Mechanism → hypothesis mapping (harness-evolution T3) ─────────────────

/**
 * Deterministic mapping from failure mechanism to fix direction and
 * implicated resource types. Lives in Reflect (the optimizer side) — the
 * evidence bundle itself carries no prescriptions.
 */
const MECHANISM_HINTS: Record<FailureMechanism, {
  fixDirection: Hypothesis['fixDirection'];
  implicatedTypes: ResourceType[];
}> = {
  retry_loop: { fixDirection: 'prompt_tune', implicatedTypes: ['Agent', 'Prompt'] as ResourceType[] },
  missing_artifact: { fixDirection: 'tool_replace', implicatedTypes: ['Tool'] as ResourceType[] },
  exploration_stall: { fixDirection: 'prompt_tune', implicatedTypes: ['Agent', 'Prompt'] as ResourceType[] },
  schema_invalid: { fixDirection: 'tool_replace', implicatedTypes: ['Tool'] as ResourceType[] },
  timeout_unbounded: { fixDirection: 'config_change', implicatedTypes: ['Tool', 'Agent'] as ResourceType[] },
  permission_blocked: { fixDirection: 'config_change', implicatedTypes: ['Tool'] as ResourceType[] },
  env_missing_dependency: { fixDirection: 'config_change', implicatedTypes: ['Tool'] as ResourceType[] },
  unknown: { fixDirection: 'prompt_tune', implicatedTypes: ['Agent', 'Tool'] as ResourceType[] },
};

const CAUSAL_BASE_CONFIDENCE: Record<string, number> = {
  direct: 0.5,
  contributing: 0.35,
  incidental: 0.2,
};

// ─── Reflect Operator ────────────────────────────────────────────────────────

export class ReflectOperator implements SEPLOperator<TraceSpace, HypothesisSpace> {
  readonly name = 'Reflect';

  private traceManager: TraceManager;
  private iteration: number;

  constructor(traceManager: TraceManager, iteration = 0) {
    this.traceManager = traceManager;
    this.iteration = iteration;
  }

  async execute(
    state: EvolvableState,
    input: TraceSpace
  ): Promise<SEPLOutput<HypothesisSpace>> {
    const startTime = Date.now();

    try {
      const hypotheses = this.generateHypotheses(input, state);

      return {
        state,
        output: {
          hypotheses,
          generatedAt: Date.now(),
          iteration: this.iteration,
        },
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        state,
        output: { hypotheses: [], generatedAt: Date.now(), iteration: this.iteration },
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Analyze trace data to generate causal hypotheses.
   *
   * When a structured evidence bundle is present (harness-evolution T3),
   * hypotheses are derived from signature clusters. The legacy string-count
   * heuristics remain as a fallback for traces without evidence.
   */
  private generateHypotheses(trace: TraceSpace, state: EvolvableState): Hypothesis[] {
    if (trace.evidence && trace.evidence.clusters.length > 0) {
      return this.generateHypothesesFromEvidence(trace.evidence.clusters, state);
    }
    return this.generateLegacyHypotheses(trace, state);
  }

  /**
   * Evidence-driven path: one hypothesis per signature cluster, ordered by
   * cluster weight (deterministic given a deterministic bundle).
   */
  private generateHypothesesFromEvidence(
    clusters: EvidenceCluster[],
    state: EvolvableState
  ): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];

    for (const cluster of clusters) {
      const { terminalCause, causalStatus, mechanism } = cluster.signature;
      const hints = MECHANISM_HINTS[mechanism];
      const base = CAUSAL_BASE_CONFIDENCE[causalStatus] ?? 0.2;
      const confidence = Math.min(0.9, base + cluster.count * 0.1);

      // Suspect the tools that produced the representative events, but only
      // if they are actually in the evolvable subspace.
      const suspectedResources = Array.from(new Set(
        cluster.representativeEvents
          .map(e => `Tool:${e.source}`)
          .filter(key => state.trainableSubset.some(k => k.startsWith(key)))
      ));

      hypotheses.push({
        id: generateHypothesisId(),
        description: `Failure cluster [${mechanism}] terminalCause=${terminalCause} (${causalStatus}), observed ${cluster.count} time(s)`,
        confidence,
        implicatedTypes: hints.implicatedTypes,
        suspectedResources,
        fixDirection: hints.fixDirection,
        evidence: [
          `terminalCause=${terminalCause}`,
          `mechanism=${mechanism}`,
          `causalStatus=${causalStatus}`,
          `count=${cluster.count}`,
          ...cluster.sharedSymptoms.map(s => `symptom: ${s}`),
        ],
      });
    }

    hypotheses.sort((a, b) => b.confidence - a.confidence);
    return hypotheses;
  }

  /**
   * Legacy fallback: pattern matching heuristics over the string-count
   * execution summary (no LLM required for basic analysis).
   */
  private generateLegacyHypotheses(trace: TraceSpace, state: EvolvableState): Hypothesis[] {
    const hypotheses: Hypothesis[] = [];
    const summary = trace.executionSummary;

    // Hypothesis 1: Tool failure patterns
    if (summary.toolFailures.length > 0) {
      for (const failure of summary.toolFailures) {
        const resourceKey = `Tool:${failure.name}`;
        const hasEvolvableTool = state.trainableSubset.some(k => k.startsWith(resourceKey));

        hypotheses.push({
          id: generateHypothesisId(),
          description: `Tool "${failure.name}" failed ${failure.count} time(s): ${failure.errorMessage ?? 'unknown error'}`,
          confidence: Math.min(0.9, 0.3 + failure.count * 0.15),
          implicatedTypes: ['Tool'] as ResourceType[],
          suspectedResources: hasEvolvableTool ? [resourceKey] : [],
          fixDirection: 'tool_replace',
          evidence: [
            `Error count: ${failure.count}`,
            `Error message: ${failure.errorMessage ?? 'N/A'}`,
          ],
        });
      }
    }

    // Hypothesis 2: High latency patterns
    if (summary.averageLatencyMs > 10000) {
      const slowTools = summary.toolFailures
        .filter(f => f.name)
        .map(f => f.name);
      hypotheses.push({
        id: generateHypothesisId(),
        description: `High average latency (${summary.averageLatencyMs}ms) suggests inefficient tool usage or suboptimal agent routing`,
        confidence: Math.min(0.8, summary.averageLatencyMs / 30000),
        implicatedTypes: ['Agent', 'Tool'] as ResourceType[],
        suspectedResources: state.trainableSubset
          .filter(k => k.includes(':systemPrompt') || k.includes(':description'))
          .map(k => k.split(':')[0] + ':' + k.split(':')[1]),
        fixDirection: 'prompt_tune',
        evidence: [
          `Average latency: ${summary.averageLatencyMs}ms`,
          `Error rate: ${summary.errorCount}/${summary.totalEvents}`,
        ],
      });
    }

    // Hypothesis 3: LLM issues
    if (summary.llmIssues.length > 0) {
      for (const issue of summary.llmIssues) {
        hypotheses.push({
          id: generateHypothesisId(),
          description: `LLM "${issue.model}" produced errors: ${issue.errorMessage ?? 'unknown'}`,
          confidence: 0.5,
          implicatedTypes: ['Prompt'] as ResourceType[],
          suspectedResources: state.trainableSubset
            .filter(k => k.includes(':template') || k.includes(':systemPrompt'))
            .slice(0, 3),
          fixDirection: 'prompt_tune',
          evidence: [`Model: ${issue.model}`, `Error: ${issue.errorMessage ?? 'N/A'}`],
        });
      }
    }

    // Hypothesis 4: High error rate
    if (summary.totalEvents > 0) {
      const errorRate = summary.errorCount / summary.totalEvents;
      if (errorRate > 0.2) {
        hypotheses.push({
          id: generateHypothesisId(),
          description: `High overall error rate (${(errorRate * 100).toFixed(1)}%) suggests systemic issues with agent configuration or prompt quality`,
          confidence: Math.min(0.85, errorRate),
          implicatedTypes: ['Agent', 'Prompt', 'Tool'] as ResourceType[],
          suspectedResources: state.trainableSubset.slice(0, 5),
          fixDirection: 'agent_rewire',
          evidence: [
            `Error rate: ${(errorRate * 100).toFixed(1)}%`,
            `Total events: ${summary.totalEvents}`,
            `Errors: ${summary.errorCount}`,
          ],
        });
      }
    }

    // Hypothesis 5: Memory-related (if memory errors appear)
    const memoryErrors = summary.failurePatterns.entries
      ? Array.from(summary.failurePatterns.entries())
          .filter(([msg]) => msg.toLowerCase().includes('memory') || msg.toLowerCase().includes('context'))
      : [];
    if (memoryErrors.length > 0) {
      hypotheses.push({
        id: generateHypothesisId(),
        description: `Memory/context-related failures detected — memory configuration may need tuning`,
        confidence: 0.6,
        implicatedTypes: ['Mem'] as ResourceType[],
        suspectedResources: state.trainableSubset
          .filter(k => k.startsWith('Mem:')),
        fixDirection: 'memory_update',
        evidence: memoryErrors.map(([msg, count]) => `${msg}: ${count} occurrences`),
      });
    }

    // Sort by confidence descending
    hypotheses.sort((a, b) => b.confidence - a.confidence);

    return hypotheses;
  }
}

// ─── Helper: Build TraceSpace from TraceManager ──────────────────────────────

/**
 * Extract a TraceSpace from a TraceManager for the Reflect operator.
 */
export function buildTraceSpace(
  traceManager: TraceManager,
  sessionId?: string
): TraceSpace {
  const summary = traceManager.generateExecutionSummary(sessionId);

  // Aggregate tool failures
  const toolFailureMap = new Map<string, { name: string; errorMessage?: string; count: number }>();
  for (const call of summary.toolCalls) {
    if (!call.isError) continue;
    const existing = toolFailureMap.get(call.name);
    if (existing) {
      existing.count++;
    } else {
      toolFailureMap.set(call.name, { name: call.name, errorMessage: undefined, count: 1 });
    }
  }

  // Extract LLM issues
  const llmIssues = summary.llmCalls
    .filter(c => summary.errorEvents.some(e => e.source === c.model))
    .map(c => ({ model: c.model, errorMessage: undefined }));

  return {
    executionSummary: {
      totalEvents: summary.totalEvents,
      errorCount: summary.errorEvents.length,
      failurePatterns: summary.failurePatterns,
      averageLatencyMs: summary.averageLatencyMs,
      toolFailures: Array.from(toolFailureMap.values()),
      llmIssues,
    },
    sessionId,
    // harness-evolution T3: structured failure evidence for the Reflect
    // operator. Optional field — consumers without evidence still work.
    evidence: traceManager.buildEvidenceBundle(sessionId),
  };
}
