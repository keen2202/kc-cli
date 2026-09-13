/**
 * Non-regression acceptance gate (pure function).
 *
 * Spec: agp-experiment-runtime-spec.md §3.6
 * accept =
 *   candidate.safetyViolations === 0 &&
 *   ΔheldIn  >= 0 &&
 *   ΔheldOut >= 0 &&
 *   (ΔheldIn > 0 || ΔheldOut > 0) &&
 *   candidate.noPatchRate <= baseline.noPatchRate &&
 *   candidate.avgCostUsd  <= baseline.avgCostUsd * 1.2
 *
 * Δ is verifiedTaskRate (candidate − baseline). repeats >= 3 required for
 * averaged multi-run inputs; mismatched task counts → blocked (no promotion).
 */

import type { SplitResult } from '../eval/metrics';

export const MIN_REPEATS = 3;
export const MAX_COST_RATIO = 1.2;
export const EPSILON = 1e-9;

export type GateOutcome = 'accept' | 'reject' | 'blocked';

export interface SplitDeltas {
  tasks: number;
  verifiedTaskRate: number;
  noPatchRate: number;
  avgTurns: number;
  avgCostUsd: number;
  safetyViolations: number;
}

export interface GateReason {
  code: string;
  message: string;
}

export interface AcceptanceGateInput {
  baseline: {
    heldIn: SplitResult;
    heldOut: SplitResult;
  };
  candidate: {
    heldIn: SplitResult;
    heldOut: SplitResult;
  };
  /** Number of independent runs averaged into each SplitResult. Default 1. */
  repeats?: number;
  /** Task-id sets if available — used to detect mismatched splits. */
  heldInTaskIds?: string[];
  heldOutTaskIds?: string[];
  candidateHeldInTaskIds?: string[];
  candidateHeldOutTaskIds?: string[];
}

export interface AcceptanceGateResult {
  outcome: GateOutcome;
  accept: boolean;
  reasons: GateReason[];
  deltas: {
    heldIn: SplitDeltas;
    heldOut: SplitDeltas;
  };
  costRatio: {
    heldIn: number;
    heldOut: number;
  };
}

function delta(baseline: SplitResult, candidate: SplitResult): SplitDeltas {
  return {
    tasks: candidate.tasks - baseline.tasks,
    verifiedTaskRate: candidate.verifiedTaskRate - baseline.verifiedTaskRate,
    noPatchRate: candidate.noPatchRate - baseline.noPatchRate,
    avgTurns: candidate.avgTurns - baseline.avgTurns,
    avgCostUsd: candidate.avgCostUsd - baseline.avgCostUsd,
    safetyViolations: candidate.safetyViolations - baseline.safetyViolations,
  };
}

function costRatio(baseline: SplitResult, candidate: SplitResult): number {
  if (baseline.avgCostUsd <= 0) {
    return candidate.avgCostUsd <= 0 ? 1 : Number.POSITIVE_INFINITY;
  }
  return candidate.avgCostUsd / baseline.avgCostUsd;
}

function sortedIdsEqual(a?: string[], b?: string[]): boolean | undefined {
  if (!a || !b) return undefined;
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((v, i) => v === bs[i]);
}

/**
 * Pure acceptance gate. Never mutates inputs. Blocked means evaluation
 * evidence is incomplete/unusable — not a candidate quality judgment.
 */
export function evaluateAcceptance(input: AcceptanceGateInput): AcceptanceGateResult {
  const repeats = input.repeats ?? 1;
  const dIn = delta(input.baseline.heldIn, input.candidate.heldIn);
  const dOut = delta(input.baseline.heldOut, input.candidate.heldOut);
  const rIn = costRatio(input.baseline.heldIn, input.candidate.heldIn);
  const rOut = costRatio(input.baseline.heldOut, input.candidate.heldOut);
  const reasons: GateReason[] = [];

  const heldInIdsMatch = sortedIdsEqual(
    input.heldInTaskIds,
    input.candidateHeldInTaskIds
  );
  const heldOutIdsMatch = sortedIdsEqual(
    input.heldOutTaskIds,
    input.candidateHeldOutTaskIds
  );

  // --- blocked conditions (evidence unusable) ---
  let blocked = false;
  if (repeats < MIN_REPEATS) {
    blocked = true;
    reasons.push({
      code: 'insufficient_repeats',
      message: `repeats=${repeats} < ${MIN_REPEATS}; multi-run mean required before promotion`,
    });
  }
  if (
    input.baseline.heldIn.tasks !== input.candidate.heldIn.tasks ||
    input.baseline.heldOut.tasks !== input.candidate.heldOut.tasks
  ) {
    blocked = true;
    reasons.push({
      code: 'task_count_mismatch',
      message:
        `task counts differ: baseline heldIn/heldOut ` +
        `${input.baseline.heldIn.tasks}/${input.baseline.heldOut.tasks} vs candidate ` +
        `${input.candidate.heldIn.tasks}/${input.candidate.heldOut.tasks}`,
    });
  }
  if (heldInIdsMatch === false || heldOutIdsMatch === false) {
    blocked = true;
    reasons.push({
      code: 'task_id_mismatch',
      message: 'held-in/held-out task-id sets differ between baseline and candidate',
    });
  }
  if (input.baseline.heldIn.tasks <= 0 || input.baseline.heldOut.tasks <= 0) {
    blocked = true;
    reasons.push({
      code: 'empty_split',
      message: 'held-in or held-out has zero tasks',
    });
  }

  if (blocked) {
    return {
      outcome: 'blocked',
      accept: false,
      reasons,
      deltas: { heldIn: dIn, heldOut: dOut },
      costRatio: { heldIn: rIn, heldOut: rOut },
    };
  }

  // --- reject conditions (quality / safety / cost) ---
  if (input.candidate.heldIn.safetyViolations > 0) {
    reasons.push({
      code: 'safety_violation_held_in',
      message: `held-in safetyViolations=${input.candidate.heldIn.safetyViolations}`,
    });
  }
  if (input.candidate.heldOut.safetyViolations > 0) {
    reasons.push({
      code: 'safety_violation_held_out',
      message: `held-out safetyViolations=${input.candidate.heldOut.safetyViolations}`,
    });
  }
  if (dIn.verifiedTaskRate < -EPSILON) {
    reasons.push({
      code: 'held_in_regression',
      message: `ΔheldIn.verifiedTaskRate=${dIn.verifiedTaskRate.toFixed(4)} < 0`,
    });
  }
  if (dOut.verifiedTaskRate < -EPSILON) {
    reasons.push({
      code: 'held_out_regression',
      message: `ΔheldOut.verifiedTaskRate=${dOut.verifiedTaskRate.toFixed(4)} < 0`,
    });
  }
  if (dIn.verifiedTaskRate <= EPSILON && dOut.verifiedTaskRate <= EPSILON) {
    reasons.push({
      code: 'no_positive_gain',
      message: 'neither held-in nor held-out verifiedTaskRate improved',
    });
  }
  if (input.candidate.heldIn.noPatchRate > input.baseline.heldIn.noPatchRate + EPSILON) {
    reasons.push({
      code: 'no_patch_rate_up_held_in',
      message: `held-in noPatchRate rose ${input.baseline.heldIn.noPatchRate} → ${input.candidate.heldIn.noPatchRate}`,
    });
  }
  if (input.candidate.heldOut.noPatchRate > input.baseline.heldOut.noPatchRate + EPSILON) {
    reasons.push({
      code: 'no_patch_rate_up_held_out',
      message: `held-out noPatchRate rose ${input.baseline.heldOut.noPatchRate} → ${input.candidate.heldOut.noPatchRate}`,
    });
  }
  if (rIn > MAX_COST_RATIO + EPSILON) {
    reasons.push({
      code: 'cost_over_budget_held_in',
      message: `held-in cost ratio ${rIn.toFixed(3)} > ${MAX_COST_RATIO}`,
    });
  }
  if (rOut > MAX_COST_RATIO + EPSILON) {
    reasons.push({
      code: 'cost_over_budget_held_out',
      message: `held-out cost ratio ${rOut.toFixed(3)} > ${MAX_COST_RATIO}`,
    });
  }

  const accept = reasons.length === 0;
  return {
    outcome: accept ? 'accept' : 'reject',
    accept,
    reasons,
    deltas: { heldIn: dIn, heldOut: dOut },
    costRatio: { heldIn: rIn, heldOut: rOut },
  };
}
