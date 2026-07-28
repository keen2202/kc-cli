// EvolutionLoop production wiring tests (harness-evolution T4/T5/T7).
// Covers: setEvaluatorBackend/setBaselineSplits delegation to the loop's
// Evaluate operator, Evaluate → Commit gate-decision handoff inside
// runSingleCycle, audit-context stamping (sessionId + iteration), and
// deps.auditLog passthrough to CommitOperator's rejected-candidate audit.
// Also pins the stale-gate-decision reset on the heuristic Evaluate path.

import { describe, it, expect, vi } from 'vitest';
import { EvolutionLoop } from '../../src/agp/sepl/evolution-loop';
import { EvaluateOperator } from '../../src/agp/sepl/evaluate';
import { AuditLog } from '../../src/agp/audit-log';
import { VersionManager } from '../../src/agp/version-manager';
import { TraceManager } from '../../src/agp/trace-manager';
import { createEmptyEvolvableState } from '../../src/agp/sepl/protocol';
import type {
  EvaluationSpace,
  EvaluatorBackend,
  EvolvableState,
  GateDecision,
  Modification,
  ObjectiveSpec,
  SplitResult,
} from '../../src/agp/sepl/protocol';
import type { ServerInterface } from '../../src/agp/server-interface';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const stubServer = {
  restore() {},
  set_variables() {},
  listAll: () => [],
} as unknown as ServerInterface;

const objective: ObjectiveSpec = {
  primaryMetric: 'success_rate',
  minimumThreshold: 0,
  safetyConstraints: [],
};

const modification: Modification = {
  id: 'mod-wiring',
  hypothesisId: 'hyp-wiring',
  targetResource: 'Prompt:test-prompt',
  resourceType: 'Prompt' as Modification['resourceType'],
  changeType: 'template_rewrite',
  proposedValue: 'improved template',
  estimatedImpact: 0.6,
  riskLevel: 'low',
};

function splitResult(split: 'held_in' | 'held_out', passed: number, total: number): SplitResult {
  return { split, repeats: [{ repeat: 0, passed, total }] };
}

/** Deterministic in-memory backend — no shell required. */
function makeBackend(rates: { heldIn: [number, number]; heldOut: [number, number] }): EvaluatorBackend {
  return {
    name: 'stub',
    evaluate: async (_state, split) =>
      split === 'held_in'
        ? splitResult('held_in', ...rates.heldIn)
        : splitResult('held_out', ...rates.heldOut),
  };
}

function rejectDecision(reason: string): GateDecision {
  return {
    format: 'kc.acceptance_gate.v1',
    rule: 'Δin ≥ 0 && Δho ≥ 0 && max > 0',
    splits: [],
    decision: 'reject',
    reason,
    evaluatedAt: Date.now(),
  };
}

function rejectedEvalSpace(): EvaluationSpace {
  return {
    results: [
      {
        accepted: false,
        primaryScore: 0.4,
        metricScores: {},
        safetyPassed: true,
        failedConstraints: [],
        improvementDelta: -0.1,
        summary: 'candidate 1 on Prompt:test-prompt',
      },
    ],
    baseline: {},
    bestCandidateIndex: -1,
  };
}

/** Passthrough stub for a SEPL operator stage. */
function passthrough<T>(output: T) {
  return {
    execute: async (state: EvolvableState) => ({
      state,
      output,
      success: true,
      durationMs: 0,
    }),
  };
}

function makeLoop(auditLog?: AuditLog): EvolutionLoop {
  return new EvolutionLoop(
    {
      traceManager: new TraceManager(),
      serverInterface: stubServer,
      versionManager: new VersionManager(),
      auditLog,
    },
    { maxIterations: 1, acceptanceGate: { enabled: true } }
  );
}

// ─── T5: backend/baseline delegation ─────────────────────────────────────────

describe('EvolutionLoop — evaluator backend delegation (T5)', () => {
  it('delegates setEvaluatorBackend and setBaselineSplits to the Evaluate operator', () => {
    const loop = makeLoop();
    const evaluate = (loop as any).operators.evaluate as EvaluateOperator;
    const backendSpy = vi.spyOn(evaluate, 'setEvaluatorBackend');
    const splitsSpy = vi.spyOn(evaluate, 'setBaselineSplits');

    const backend = makeBackend({ heldIn: [3, 3], heldOut: [2, 2] });
    const baseline = [splitResult('held_in', 2, 3), splitResult('held_out', 2, 2)];

    loop.setEvaluatorBackend(backend);
    loop.setBaselineSplits(baseline);
    expect(backendSpy).toHaveBeenCalledWith(backend);
    expect(splitsSpy).toHaveBeenCalledWith(baseline);

    loop.setEvaluatorBackend(null);
    loop.setBaselineSplits(null);
    expect(backendSpy).toHaveBeenLastCalledWith(null);
    expect(splitsSpy).toHaveBeenLastCalledWith(null);
  });
});

// ─── T4 + T7: gate handoff and rejected-candidate audit through run() ────────

describe('EvolutionLoop — gate handoff and audit context (T4/T7)', () => {
  it('hands the gate decision to Commit and stamps rejected audit entries with cycle context', async () => {
    const auditLog = new AuditLog();
    const loop = makeLoop(auditLog);

    // Stub the first four stages so the cycle reaches the REAL CommitOperator
    // (constructed by the loop with acceptanceGate + auditLog) with a
    // rejecting gate decision from Evaluate.
    const ops = (loop as any).operators;
    ops.reflect = passthrough({
      hypotheses: [{ id: 'hyp-wiring' }],
      generatedAt: Date.now(),
      iteration: 0,
    });
    ops.select = passthrough({
      modifications: [modification],
      sourceHypothesisId: 'hyp-wiring',
    });
    ops.improve = passthrough({
      modifications: [modification],
      sourceHypothesisId: 'hyp-wiring',
    });
    ops.evaluate = {
      ...passthrough(rejectedEvalSpace()),
      getLastGateDecision: () => rejectDecision('held_out regression: Δho = -0.40'),
    };

    const results = await loop.run(createEmptyEvolvableState(), 'sess-loop');

    expect(results).toHaveLength(1);
    expect(results[0].committed).toBe(false);

    // deps.auditLog reached CommitOperator, and setGateDecision/setAuditContext
    // were called before commit: the rejected entry carries the loop's cycle
    // context and the gate reason.
    const rejected = auditLog.query({ phase: 'rejected' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].sessionId).toBe('sess-loop');
    expect(rejected[0].iteration).toBe(0);
    expect(String(rejected[0].details.reason)).toContain('held_out regression');
  });

  it('falls back to "unknown" sessionId when run() gets no session', async () => {
    const auditLog = new AuditLog();
    const loop = makeLoop(auditLog);

    const ops = (loop as any).operators;
    ops.reflect = passthrough({ hypotheses: [{ id: 'h' }], generatedAt: Date.now(), iteration: 0 });
    ops.select = passthrough({ modifications: [modification], sourceHypothesisId: 'h' });
    ops.improve = passthrough({ modifications: [modification], sourceHypothesisId: 'h' });
    ops.evaluate = {
      ...passthrough(rejectedEvalSpace()),
      getLastGateDecision: () => null,
    };

    await loop.run(createEmptyEvolvableState());

    const rejected = auditLog.query({ phase: 'rejected' });
    expect(rejected).toHaveLength(1);
    expect(rejected[0].sessionId).toBe('unknown');
  });
});

// ─── Evaluate: stale gate decision reset ─────────────────────────────────────

describe('EvaluateOperator — gate decision lifetime', () => {
  it('clears a stale gate decision when a later run uses the heuristic path', async () => {
    const evaluate = new EvaluateOperator(
      objective,
      new TraceManager(),
      {},
      makeBackend({ heldIn: [3, 3], heldOut: [2, 2] })
    );
    evaluate.setBaselineSplits([splitResult('held_in', 2, 3), splitResult('held_out', 2, 2)]);

    await evaluate.execute(createEmptyEvolvableState(), {
      modifications: [modification],
      sourceHypothesisId: 'hyp-wiring',
    });
    expect(evaluate.getLastGateDecision()).not.toBeNull();

    // Backend removed → heuristic path must not leak the previous verdict.
    evaluate.setEvaluatorBackend(null);
    await evaluate.execute(createEmptyEvolvableState(), {
      modifications: [modification],
      sourceHypothesisId: 'hyp-wiring',
    });
    expect(evaluate.getLastGateDecision()).toBeNull();
  });
});
