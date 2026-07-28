/**
 * Acceptance gate tests (harness-evolution T4).
 *
 * Full branch coverage of the pure gate function (improved / dropped /
 * unchanged, incomparable inputs), JSON contract shape, persistence, and
 * CommitOperator integration (gate off = unchanged behavior).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  runAcceptanceGate,
  persistGateDecision,
  ACCEPTANCE_RULE,
} from '../../src/agp/sepl/acceptance-gate';
import { CommitOperator } from '../../src/agp/sepl/commit';
import { createEmptyEvolvableState } from '../../src/agp/sepl/protocol';
import type { SplitResult, EvaluationSpace, GateDecision } from '../../src/agp/sepl/protocol';
import { KCError } from '../../src/utils/errors';

/** Shorthand: build a two-repeat SplitResult over a fixed denominator. */
function split(name: 'held_in' | 'held_out', passed: [number, number], total = 10): SplitResult {
  return {
    split: name,
    repeats: [
      { repeat: 0, passed: passed[0], total },
      { repeat: 1, passed: passed[1], total },
    ],
  };
}

function pair(inBase: [number, number], hoBase: [number, number], inCand: [number, number], hoCand: [number, number]) {
  return {
    baseline: [split('held_in', inBase), split('held_out', hoBase)],
    candidate: [split('held_in', inCand), split('held_out', hoCand)],
  };
}

describe('runAcceptanceGate', () => {
  it('accepts when one split improves and the other is unchanged', () => {
    const { baseline, candidate } = pair([5, 5], [5, 5], [6, 6], [5, 5]);
    const decision = runAcceptanceGate(baseline, candidate);
    expect(decision.decision).toBe('accept');
    expect(decision.reason).toContain('held_in');
    expect(decision.reason).toContain('improvement');
  });

  it('accepts when both splits improve', () => {
    const { baseline, candidate } = pair([5, 5], [5, 5], [7, 7], [6, 6]);
    const decision = runAcceptanceGate(baseline, candidate);
    expect(decision.decision).toBe('accept');
  });

  it('rejects on regression even if the other split improves', () => {
    const { baseline, candidate } = pair([5, 5], [5, 5], [9, 9], [4, 4]);
    const decision = runAcceptanceGate(baseline, candidate);
    expect(decision.decision).toBe('reject');
    expect(decision.reason).toContain('regression');
    expect(decision.reason).toContain('held_out');
  });

  it('rejects when nothing changes on any split', () => {
    const { baseline, candidate } = pair([5, 5], [5, 5], [5, 5], [5, 5]);
    const decision = runAcceptanceGate(baseline, candidate);
    expect(decision.decision).toBe('reject');
    expect(decision.reason).toBe('no improvement on any split');
  });

  it('emits the versioned contract shape', () => {
    const { baseline, candidate } = pair([5, 5], [5, 5], [6, 6], [5, 5]);
    const decision = runAcceptanceGate(baseline, candidate);
    expect(decision.format).toBe('kc.acceptance_gate.v1');
    expect(decision.rule).toBe(ACCEPTANCE_RULE);
    expect(decision.splits).toHaveLength(2);
    expect(decision.splits[0]).toEqual({
      split: 'held_in',
      baselinePassRate: 0.5,
      candidatePassRate: 0.6,
      delta: expect.closeTo(0.1, 9),
    });
    expect(decision.evaluatedAt).toBeGreaterThan(0);
  });

  it('throws evaluation_incomparable when denominators differ', () => {
    const baseline = [split('held_in', [5, 5], 10), split('held_out', [5, 5], 10)];
    const candidate = [split('held_in', [5, 5], 12), split('held_out', [5, 5], 10)];
    expect(() => runAcceptanceGate(baseline, candidate)).toThrowError(KCError);
    try {
      runAcceptanceGate(baseline, candidate);
    } catch (e) {
      expect((e as KCError).code).toBe('evaluation_incomparable');
      expect((e as KCError).message).toContain('repeat sequences differ');
    }
  });

  it('throws when repeat counts do not match the expected repeats', () => {
    const baseline = [split('held_in', [5, 5]), split('held_out', [5, 5])];
    const candidate = [
      { split: 'held_in' as const, repeats: [{ repeat: 0, passed: 5, total: 10 }] },
      split('held_out', [5, 5]),
    ];
    expect(() => runAcceptanceGate(baseline, candidate)).toThrowError(/exactly 2 repeat/);
  });

  it('throws on duplicate repeat ids', () => {
    const dup: SplitResult = {
      split: 'held_in',
      repeats: [
        { repeat: 0, passed: 5, total: 10 },
        { repeat: 0, passed: 6, total: 10 },
      ],
    };
    const other = split('held_out', [5, 5]);
    expect(() => runAcceptanceGate([dup, other], [dup, other])).toThrowError(/duplicate repeat id/);
  });

  it('throws when a required split is missing', () => {
    const baseline = [split('held_in', [5, 5])];
    const candidate = [split('held_in', [6, 6])];
    expect(() => runAcceptanceGate(baseline, candidate)).toThrowError(/held_out.*missing/);
  });

  it('throws on duplicate splits on one side', () => {
    const baseline = [split('held_in', [5, 5]), split('held_in', [5, 5]), split('held_out', [5, 5])];
    const candidate = [split('held_in', [5, 5]), split('held_out', [5, 5])];
    expect(() => runAcceptanceGate(baseline, candidate)).toThrowError(/duplicate split/);
  });

  it('throws on non-positive totals and out-of-range passed counts', () => {
    const zeroTotal: SplitResult = {
      split: 'held_in',
      repeats: [
        { repeat: 0, passed: 0, total: 0 },
        { repeat: 1, passed: 0, total: 0 },
      ],
    };
    const other = split('held_out', [5, 5]);
    expect(() => runAcceptanceGate([zeroTotal, other], [zeroTotal, other])).toThrowError(/non-positive total/);

    const overPassed = split('held_in', [11, 5], 10);
    expect(() => runAcceptanceGate([overPassed, other], [overPassed, other])).toThrowError(/invalid passed/);
  });

  it('throws when opts.repeats is non-positive', () => {
    const { baseline, candidate } = pair([5, 5], [5, 5], [6, 6], [5, 5]);
    expect(() => runAcceptanceGate(baseline, candidate, { repeats: 0 })).toThrowError(/must be positive/);
  });

  it('supports custom repeats count via opts', () => {
    const one = (name: 'held_in' | 'held_out', passed: number): SplitResult => ({
      split: name,
      repeats: [{ repeat: 0, passed, total: 10 }],
    });
    const decision = runAcceptanceGate(
      [one('held_in', 5), one('held_out', 5)],
      [one('held_in', 6), one('held_out', 5)],
      { repeats: 1 }
    );
    expect(decision.decision).toBe('accept');
  });
});

describe('persistGateDecision', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('writes the decision as parseable JSON into the audit dir', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-gate-'));
    const { baseline, candidate } = pair([5, 5], [5, 5], [6, 6], [5, 5]);
    const decision = runAcceptanceGate(baseline, candidate);

    const filePath = persistGateDecision(decision, tmpDir);
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(parsed.format).toBe('kc.acceptance_gate.v1');
    expect(parsed.decision).toBe('accept');
    expect(parsed.rule).toBe(ACCEPTANCE_RULE);
  });
});

describe('CommitOperator acceptance-gate integration', () => {
  const stubServer = { restore: () => {} } as any;
  const stubVersions = {
    getActiveVersion: () => null,
    nextVersion: () => 'v2',
    createSnapshot: () => null,
    rollback: () => {},
    getLineage: () => [],
  } as any;

  const evalSpace = (accepted: boolean): EvaluationSpace => ({
    results: [{
      accepted,
      primaryScore: accepted ? 0.9 : 0.1,
      metricScores: {},
      safetyPassed: true,
      failedConstraints: [],
      improvementDelta: accepted ? 0.1 : -0.5,
      summary: `candidate on Prompt:test-prompt`,
    }],
    baseline: {},
    bestCandidateIndex: accepted ? 0 : -1,
  });

  const gateDecision = (decision: 'accept' | 'reject'): GateDecision => ({
    format: 'kc.acceptance_gate.v1',
    rule: ACCEPTANCE_RULE,
    splits: [],
    decision,
    reason: decision === 'reject' ? 'regression on held_out (delta=-0.100000)' : 'improvement',
    evaluatedAt: Date.now(),
  });

  it('gate disabled (default): heuristic decision unchanged, decision ignored', async () => {
    const op = new CommitOperator(stubServer, stubVersions, false);
    op.setGateDecision(gateDecision('reject'));
    const result = await op.execute(createEmptyEvolvableState(), evalSpace(true));
    expect(result.output.accepted).toBe(true); // heuristic accept wins, gate off
  });

  it('gate enabled + reject decision overrides heuristic accept', async () => {
    const op = new CommitOperator(stubServer, stubVersions, false, { enabled: true });
    op.setGateDecision(gateDecision('reject'));
    const result = await op.execute(createEmptyEvolvableState(), evalSpace(true));
    expect(result.output.accepted).toBe(false);
    expect(result.output.reason).toContain('Acceptance gate rejected');
    expect(result.output.reason).toContain('regression on held_out');
  });

  it('gate enabled + accept decision overrides heuristic reject', async () => {
    const op = new CommitOperator(stubServer, stubVersions, false, { enabled: true });
    op.setGateDecision(gateDecision('accept'));
    const result = await op.execute(createEmptyEvolvableState(), evalSpace(false));
    expect(result.output.accepted).toBe(true);
  });

  it('gate enabled but no decision supplied: heuristic path unchanged', async () => {
    const op = new CommitOperator(stubServer, stubVersions, false, { enabled: true });
    const result = await op.execute(createEmptyEvolvableState(), evalSpace(false));
    expect(result.output.accepted).toBe(false);
    expect(result.output.reason).toBe('No candidates passed evaluation');
  });
});
