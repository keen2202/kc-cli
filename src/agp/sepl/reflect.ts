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
} from './protocol';
import { generateHypothesisId } from './protocol';
import type { ResourceType } from '../protocol';

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
   * Uses pattern matching heuristics (no LLM required for basic analysis).
   */
  private generateHypotheses(trace: TraceSpace, state: EvolvableState): Hypothesis[] {
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
  };
}
