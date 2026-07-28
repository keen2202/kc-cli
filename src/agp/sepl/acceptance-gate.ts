/**
 * SEPL Non-Regressive Acceptance Gate (harness-evolution T4 / H4)
 *
 * Pure-function port of the Self-Harness acceptance rule
 * (acceptance/scripts/run_acceptance_gate.py):
 *
 *   accept ⇔ Δin ≥ 0 && Δho ≥ 0 && max(Δin, Δho) > 0
 *
 * i.e. no split may regress and at least one split must improve.
 *
 * Comparability is enforced hard: baseline and candidate must have been
 * measured over the exact same (repeat, total) sequences per split —
 * otherwise a KCError is thrown. Refusing to compare beats producing a
 * misleading conclusion.
 *
 * The decision is a versioned JSON contract (`kc.acceptance_gate.v1`)
 * persisted to `.kc-cli/audit/` for candidate lineage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { KCError } from '../../utils/errors';
import type { EvalSplit, GateDecision, GateSplitDetail, SplitResult } from './protocol';

/** The acceptance rule, verbatim, embedded in every decision contract. */
export const ACCEPTANCE_RULE = 'delta_in >= 0 && delta_ho >= 0 && max(delta_in, delta_ho) > 0';

/** Float tolerance for pass-rate deltas. */
const EPSILON = 1e-9;

/** Default fixed repeats per split. */
const DEFAULT_REPEATS = 2;

export interface AcceptanceGateOptions {
  /** Expected number of repeats per split (default 2) */
  repeats?: number;
}

/** Splits the rule requires — both must be present on both sides. */
const REQUIRED_SPLITS: EvalSplit[] = ['held_in', 'held_out'];

function incomparable(message: string, context?: Record<string, unknown>): KCError {
  return new KCError('evaluation_incomparable', message, context);
}

/** Index split results by split name, rejecting duplicates. */
function indexBySplit(results: SplitResult[], side: 'baseline' | 'candidate'): Map<EvalSplit, SplitResult> {
  const map = new Map<EvalSplit, SplitResult>();
  for (const result of results) {
    if (map.has(result.split)) {
      throw incomparable(`${side} contains duplicate split "${result.split}"`, { side, split: result.split });
    }
    map.set(result.split, result);
  }
  return map;
}

/**
 * Validate one split pair and compute the mean pass rate for each side.
 * Enforces: identical repeat count, identical (repeat, total) sequences,
 * unique repeat ids, positive denominators, sane passed counts.
 */
function validateAndScore(
  split: EvalSplit,
  baseline: SplitResult,
  candidate: SplitResult,
  expectedRepeats: number
): GateSplitDetail {
  if (baseline.repeats.length !== expectedRepeats || candidate.repeats.length !== expectedRepeats) {
    throw incomparable(
      `split "${split}" must have exactly ${expectedRepeats} repeat(s) on both sides ` +
      `(baseline=${baseline.repeats.length}, candidate=${candidate.repeats.length})`,
      { split, expectedRepeats }
    );
  }

  const seen = new Set<number>();
  for (let i = 0; i < expectedRepeats; i++) {
    const b = baseline.repeats[i];
    const c = candidate.repeats[i];
    if (b.repeat !== c.repeat || b.total !== c.total) {
      throw incomparable(
        `split "${split}" repeat sequences differ at index ${i}: ` +
        `baseline (repeat=${b.repeat}, total=${b.total}) vs candidate (repeat=${c.repeat}, total=${c.total})`,
        { split, index: i }
      );
    }
    if (seen.has(b.repeat)) {
      throw incomparable(`split "${split}" contains duplicate repeat id ${b.repeat}`, { split, repeat: b.repeat });
    }
    seen.add(b.repeat);
    if (b.total <= 0) {
      throw incomparable(`split "${split}" repeat ${b.repeat} has non-positive total ${b.total}`, { split });
    }
    for (const [side, r] of [['baseline', b], ['candidate', c]] as const) {
      if (r.passed < 0 || r.passed > r.total) {
        throw incomparable(
          `split "${split}" ${side} repeat ${r.repeat} has invalid passed=${r.passed} (total=${r.total})`,
          { split, side }
        );
      }
    }
  }

  const mean = (repeats: SplitResult['repeats']) =>
    repeats.reduce((sum, r) => sum + r.passed / r.total, 0) / repeats.length;

  const baselinePassRate = mean(baseline.repeats);
  const candidatePassRate = mean(candidate.repeats);
  return {
    split,
    baselinePassRate,
    candidatePassRate,
    delta: candidatePassRate - baselinePassRate,
  };
}

/**
 * Run the non-regressive acceptance gate.
 *
 * Pure function: no I/O, deterministic for a given input (modulo
 * `evaluatedAt`). Throws `KCError('evaluation_incomparable')` when the
 * inputs cannot be compared safely.
 */
export function runAcceptanceGate(
  baseline: SplitResult[],
  candidate: SplitResult[],
  opts: AcceptanceGateOptions = {}
): GateDecision {
  const expectedRepeats = opts.repeats ?? DEFAULT_REPEATS;
  if (expectedRepeats <= 0) {
    throw incomparable(`repeats must be positive (got ${expectedRepeats})`);
  }

  const baseMap = indexBySplit(baseline, 'baseline');
  const candMap = indexBySplit(candidate, 'candidate');

  const splits: GateSplitDetail[] = [];
  for (const split of REQUIRED_SPLITS) {
    const b = baseMap.get(split);
    const c = candMap.get(split);
    if (!b || !c) {
      throw incomparable(
        `split "${split}" missing on ${!b ? 'baseline' : 'candidate'} side`,
        { split }
      );
    }
    splits.push(validateAndScore(split, b, c, expectedRepeats));
  }

  const regressed = splits.filter(s => s.delta < -EPSILON);
  const improved = splits.filter(s => s.delta > EPSILON);

  let decision: GateDecision['decision'];
  let reason: string;
  if (regressed.length > 0) {
    decision = 'reject';
    reason = `regression on ${regressed.map(s => `${s.split} (delta=${s.delta.toFixed(6)})`).join(', ')}`;
  } else if (improved.length === 0) {
    decision = 'reject';
    reason = 'no improvement on any split';
  } else {
    decision = 'accept';
    reason = `non-regressive with improvement on ${improved.map(s => `${s.split} (delta=+${s.delta.toFixed(6)})`).join(', ')}`;
  }

  return {
    format: 'kc.acceptance_gate.v1',
    rule: ACCEPTANCE_RULE,
    splits,
    decision,
    reason,
    evaluatedAt: Date.now(),
  };
}

/**
 * Persist a gate decision as a versioned JSON contract.
 * Returns the absolute path of the written file.
 */
export function persistGateDecision(
  decision: GateDecision,
  auditDir: string = path.join('.kc-cli', 'audit')
): string {
  fs.mkdirSync(auditDir, { recursive: true });
  const filename = `acceptance-gate-${decision.evaluatedAt}-${decision.decision}.json`;
  const filePath = path.resolve(auditDir, filename);
  fs.writeFileSync(filePath, JSON.stringify(decision, null, 2), 'utf8');
  return filePath;
}
