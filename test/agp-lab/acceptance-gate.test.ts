import { describe, it, expect } from 'vitest';
import {
  evaluateAcceptance,
  MIN_REPEATS,
  MAX_COST_RATIO,
  type AcceptanceGateInput,
} from '../../scripts/agp/acceptance-gate';
import type { SplitResult } from '../../scripts/eval/metrics';

function split(over: Partial<SplitResult> = {}): SplitResult {
  return {
    tasks: 3,
    verifiedTaskRate: 0.5,
    noPatchRate: 0.2,
    avgTurns: 2,
    avgCostUsd: 0.01,
    safetyViolations: 0,
    ...over,
  };
}

function baseInput(over: Partial<AcceptanceGateInput> = {}): AcceptanceGateInput {
  return {
    baseline: {
      heldIn: split({ verifiedTaskRate: 0.5 }),
      heldOut: split({ tasks: 2, verifiedTaskRate: 0.5 }),
    },
    candidate: {
      heldIn: split({ verifiedTaskRate: 0.8 }),
      heldOut: split({ tasks: 2, verifiedTaskRate: 0.5 }),
    },
    repeats: MIN_REPEATS,
    ...over,
  };
}

describe('agp-lab/acceptance-gate', () => {
  it('accepts a clear improvement on held-in with no held-out regression', () => {
    const result = evaluateAcceptance(baseInput());
    expect(result.outcome).toBe('accept');
    expect(result.accept).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.deltas.heldIn.verifiedTaskRate).toBeCloseTo(0.3);
    expect(result.deltas.heldOut.verifiedTaskRate).toBeCloseTo(0);
  });

  it('accepts when held-out improves and held-in is flat', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ verifiedTaskRate: 0.5 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 1 }),
        },
      })
    );
    expect(result.accept).toBe(true);
  });

  it('rejects held-in regression', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ verifiedTaskRate: 0.2 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 0.8 }),
        },
      })
    );
    expect(result.outcome).toBe('reject');
    expect(result.reasons.map(r => r.code)).toContain('held_in_regression');
  });

  it('rejects held-out regression', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ verifiedTaskRate: 0.5 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 0.1 }),
        },
      })
    );
    expect(result.reasons.map(r => r.code)).toContain('held_out_regression');
  });

  it('rejects when both splits are flat (no positive gain)', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ verifiedTaskRate: 0.5 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 0.5 }),
        },
      })
    );
    expect(result.reasons.map(r => r.code)).toContain('no_positive_gain');
  });

  it('rejects rising noPatchRate', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ verifiedTaskRate: 0.8, noPatchRate: 0.4 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 0.5 }),
        },
      })
    );
    expect(result.reasons.map(r => r.code)).toContain('no_patch_rate_up_held_in');
  });

  it('rejects cost above 1.2x baseline', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ verifiedTaskRate: 0.8, avgCostUsd: 0.02 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 0.5 }),
        },
      })
    );
    // baseline cost 0.01, candidate 0.02 → ratio 2 > 1.2
    expect(result.reasons.map(r => r.code)).toContain('cost_over_budget_held_in');
    expect(MAX_COST_RATIO).toBe(1.2);
  });

  it('allows cost at exactly 1.2x', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ verifiedTaskRate: 0.8, avgCostUsd: 0.012 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 0.5, avgCostUsd: 0.012 }),
        },
      })
    );
    expect(result.accept).toBe(true);
  });

  it('rejects any safetyViolations', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ verifiedTaskRate: 0.8, safetyViolations: 1 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 0.5 }),
        },
      })
    );
    expect(result.reasons.map(r => r.code)).toContain('safety_violation_held_in');
  });

  it('blocks when repeats < 3', () => {
    const result = evaluateAcceptance(baseInput({ repeats: 2 }));
    expect(result.outcome).toBe('blocked');
    expect(result.accept).toBe(false);
    expect(result.reasons.map(r => r.code)).toContain('insufficient_repeats');
  });

  it('blocks when task counts mismatch', () => {
    const result = evaluateAcceptance(
      baseInput({
        candidate: {
          heldIn: split({ tasks: 5, verifiedTaskRate: 0.8 }),
          heldOut: split({ tasks: 2, verifiedTaskRate: 0.5 }),
        },
      })
    );
    expect(result.outcome).toBe('blocked');
    expect(result.reasons.map(r => r.code)).toContain('task_count_mismatch');
  });

  it('blocks when task-id sets differ', () => {
    const result = evaluateAcceptance(
      baseInput({
        heldInTaskIds: ['a', 'b', 'c'],
        candidateHeldInTaskIds: ['a', 'b', 'x'],
      })
    );
    expect(result.outcome).toBe('blocked');
    expect(result.reasons.map(r => r.code)).toContain('task_id_mismatch');
  });

  it('blocks empty splits', () => {
    const result = evaluateAcceptance(
      baseInput({
        baseline: {
          heldIn: split({ tasks: 0 }),
          heldOut: split({ tasks: 2 }),
        },
        candidate: {
          heldIn: split({ tasks: 0 }),
          heldOut: split({ tasks: 2 }),
        },
      })
    );
    expect(result.reasons.map(r => r.code)).toContain('empty_split');
  });
});
