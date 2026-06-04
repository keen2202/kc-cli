/**
 * SEPL Evaluate Operator (ε)
 *
 * Evaluates candidate states produced by Improve against the objective
 * specification. Checks safety invariants and computes improvement metrics.
 *
 * ε : (S', D') → (S', S_eval)
 * Input: Updated EvolvableState + modifications
 * Output: EvaluationSpace (scores and accept/reject decision)
 *
 * Corresponds to the paper's Evaluate operator (§4.4).
 */

import type { TraceManager } from '../trace-manager';
import type {
  SEPLOperator,
  SEPLOutput,
  EvolvableState,
  ModificationSpace,
  EvaluationSpace,
  EvaluationResult,
  ObjectiveSpec,
} from './protocol';

// ─── Evaluate Operator ───────────────────────────────────────────────────────

export class EvaluateOperator implements SEPLOperator<ModificationSpace, EvaluationSpace> {
  readonly name = 'Evaluate';

  private objective: ObjectiveSpec;
  private traceManager: TraceManager;
  private baseline: Record<string, number>;

  constructor(
    objective: ObjectiveSpec,
    traceManager: TraceManager,
    baseline?: Record<string, number>
  ) {
    this.objective = objective;
    this.traceManager = traceManager;
    this.baseline = baseline ?? {};
  }

  async execute(
    state: EvolvableState,
    input: ModificationSpace
  ): Promise<SEPLOutput<EvaluationSpace>> {
    const startTime = Date.now();

    try {
      const results: EvaluationResult[] = [];

      if (input.modifications.length === 0) {
        return {
          state,
          output: { results: [], baseline: this.baseline, bestCandidateIndex: -1 },
          success: true,
          durationMs: Date.now() - startTime,
        };
      }

      // Evaluate each modification as a candidate
      for (const mod of input.modifications) {
        const result = this.evaluateCandidate(state, mod);
        results.push(result);
      }

      // Find the best candidate
      let bestIndex = -1;
      let bestScore = -Infinity;
      for (let i = 0; i < results.length; i++) {
        if (results[i].accepted && results[i].primaryScore > bestScore) {
          bestScore = results[i].primaryScore;
          bestIndex = i;
        }
      }

      return {
        state,
        output: {
          results,
          baseline: this.baseline,
          bestCandidateIndex: bestIndex,
        },
        success: true,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        state,
        output: { results: [], baseline: this.baseline, bestCandidateIndex: -1 },
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Evaluate a single candidate modification.
   */
  private evaluateCandidate(
    state: EvolvableState,
    mod: import('./protocol').Modification
  ): EvaluationResult {
    const metricScores: Record<string, number> = {};
    const failedConstraints: string[] = [];

    // 1. Check safety constraints
    for (const constraint of this.objective.safetyConstraints) {
      const constraintState = {
        modification: mod,
        state,
        resourceType: mod.resourceType,
      };
      if (!constraint.check(constraintState)) {
        failedConstraints.push(constraint.name);
      }
    }

    const safetyPassed = failedConstraints.length === 0;

    // 2. Compute primary metric score
    const primaryScore = this.computePrimaryScore(mod, state);
    metricScores[this.objective.primaryMetric] = primaryScore;

    // 3. Compute secondary metrics
    if (this.objective.secondaryMetrics) {
      for (const secondary of this.objective.secondaryMetrics) {
        metricScores[secondary.name] = this.computeSecondaryScore(secondary.name, mod, state);
      }
    }

    // 4. Compute improvement delta over baseline
    const baselineScore = this.baseline[this.objective.primaryMetric] ?? 0;
    const improvementDelta = primaryScore - baselineScore;

    // 5. Determine acceptance
    const accepted =
      safetyPassed &&
      primaryScore >= this.objective.minimumThreshold &&
      improvementDelta >= -0.1; // Allow small regressions

    // 6. Build summary
    const summary = accepted
      ? `Accepted: ${mod.changeType} on ${mod.targetResource} (score=${primaryScore.toFixed(3)}, Δ=${improvementDelta >= 0 ? '+' : ''}${improvementDelta.toFixed(3)})`
      : `Rejected: ${mod.changeType} on ${mod.targetResource} (${!safetyPassed ? 'safety violation: ' + failedConstraints.join(', ') : `score=${primaryScore.toFixed(3)} below threshold`})`;

    return {
      accepted,
      primaryScore,
      metricScores,
      safetyPassed,
      failedConstraints,
      improvementDelta,
      summary,
    };
  }

  /**
   * Compute the primary metric score for a modification.
   * Uses heuristic scoring based on trace data and modification properties.
   */
  private computePrimaryScore(
    mod: import('./protocol').Modification,
    state: EvolvableState
  ): number {
    // Base score from estimated impact
    let score = mod.estimatedImpact;

    // Boost for low-risk changes
    if (mod.riskLevel === 'low') score += 0.1;
    if (mod.riskLevel === 'high') score -= 0.2;

    // Factor in recent error rates from trace data
    const recentErrors = this.traceManager.getErrors(10);
    const errorRate = recentErrors.length / Math.max(this.traceManager.size, 1);

    // If targeting a resource that appears in errors, boost score
    const resourceInErrors = recentErrors.some(e =>
      e.source.includes(mod.targetResource.split(':')[1] ?? '')
    );
    if (resourceInErrors) score += 0.15;

    // Penalize if overall error rate is already low (less room for improvement)
    if (errorRate < 0.05) score -= 0.1;

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Compute a secondary metric score.
   */
  private computeSecondaryScore(
    metricName: string,
    mod: import('./protocol').Modification,
    state: EvolvableState
  ): number {
    switch (metricName) {
      case 'latency_improvement':
        // Higher impact modifications likely improve latency more
        return mod.estimatedImpact * 0.8;
      case 'simplicity':
        // Prefer smaller, targeted changes
        return mod.changeType === 'metadata_update' ? 0.9 : 0.6;
      case 'coverage':
        // How many error patterns this modification addresses
        return mod.estimatedImpact;
      default:
        return 0.5;
    }
  }

  /**
   * Update the baseline metrics after evaluation.
   */
  updateBaseline(newBaseline: Record<string, number>): void {
    this.baseline = { ...this.baseline, ...newBaseline };
  }
}
