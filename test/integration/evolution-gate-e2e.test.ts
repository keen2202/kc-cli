/**
 * Evolution gate end-to-end test (harness-evolution T5).
 *
 * Full chain with a real shell: VitestEvaluatorBackend executes actual
 * child processes as verification tasks (baseline vs candidate), the T4
 * acceptance gate compares the split results, and CommitOperator honors
 * the gate decision (accept and reject paths).
 */

import { describe, it, expect } from 'vitest';
import { LocalShell } from '../../src/services/execution-env-local';
import { VitestEvaluatorBackend } from '../../src/agp/sepl/evaluator-vitest';
import { EvaluateOperator } from '../../src/agp/sepl/evaluate';
import { CommitOperator } from '../../src/agp/sepl/commit';
import { runAcceptanceGate } from '../../src/agp/sepl/acceptance-gate';
import { createEmptyEvolvableState } from '../../src/agp/sepl/protocol';
import type {
  EvolutionEvalConfig,
  Modification,
  ObjectiveSpec,
  SplitResult,
} from '../../src/agp/sepl/protocol';
import { TraceManager } from '../../src/agp/trace-manager';

const E2E_TIMEOUT = 60_000;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const evalConfig: EvolutionEvalConfig = {
  format: 'kc.evolution_eval.v1',
  heldIn: ['t1', 't2', 't3'],
  heldOut: ['t4', 't5'],
  repeats: 1,
};

const objective: ObjectiveSpec = {
  primaryMetric: 'success_rate',
  minimumThreshold: 0,
  safetyConstraints: [],
};

const modification: Modification = {
  id: 'mod-e2e',
  hypothesisId: 'hyp-e2e',
  targetResource: 'Prompt:test-prompt',
  resourceType: 'Prompt' as Modification['resourceType'],
  changeType: 'template_rewrite',
  proposedValue: 'improved template',
  estimatedImpact: 0.6,
  riskLevel: 'low',
};

/** Build a backend whose tasks exit according to the failure set. */
function makeBackend(failingTasks: Set<string>): VitestEvaluatorBackend {
  return new VitestEvaluatorBackend({
    shell: new LocalShell(),
    evalConfig,
    concurrency: 3,
    buildCommand: task =>
      failingTasks.has(task) ? 'node -e "process.exit(1)"' : 'node -e "process.exit(0)"',
  });
}

async function evaluateBothSplits(backend: VitestEvaluatorBackend): Promise<SplitResult[]> {
  const state = createEmptyEvolvableState();
  return [await backend.evaluate(state, 'held_in'), await backend.evaluate(state, 'held_out')];
}

const stubServer = { restore: () => {} } as any;
const stubVersions = {
  getActiveVersion: () => null,
  nextVersion: () => 'v2',
  createSnapshot: () => null,
  rollback: () => {},
  getLineage: () => [],
} as any;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('evolution gate e2e (real shell)', () => {
  it(
    'accepts an improved candidate through evaluate → gate → commit',
    async () => {
      // Baseline: t3 fails held-in; candidate: everything passes
      const baselineSplits = await evaluateBothSplits(makeBackend(new Set(['t3'])));
      expect(baselineSplits[0].repeats[0]).toEqual({ repeat: 0, passed: 2, total: 3 });

      const evaluate = new EvaluateOperator(objective, new TraceManager(), {}, makeBackend(new Set()));
      evaluate.setBaselineSplits(baselineSplits);

      const evalResult = await evaluate.execute(createEmptyEvolvableState(), {
        modifications: [modification],
        sourceHypothesisId: 'hyp-e2e',
      });

      expect(evalResult.success).toBe(true);
      const gateDecision = evaluate.getLastGateDecision();
      expect(gateDecision?.decision).toBe('accept');

      const commit = new CommitOperator(stubServer, stubVersions, false, { enabled: true });
      commit.setGateDecision(gateDecision);
      const commitResult = await commit.execute(createEmptyEvolvableState(), evalResult.output);

      expect(commitResult.output.accepted).toBe(true);
    },
    E2E_TIMEOUT
  );

  it(
    'rejects a candidate that regresses on held-out through the same chain',
    async () => {
      // Baseline: t3 fails held-in; candidate fixes t3 but breaks held-out t5
      const baselineSplits = await evaluateBothSplits(makeBackend(new Set(['t3'])));

      const evaluate = new EvaluateOperator(objective, new TraceManager(), {}, makeBackend(new Set(['t5'])));
      evaluate.setBaselineSplits(baselineSplits);

      const evalResult = await evaluate.execute(createEmptyEvolvableState(), {
        modifications: [modification],
        sourceHypothesisId: 'hyp-e2e',
      });

      expect(evalResult.success).toBe(true);
      const gateDecision = evaluate.getLastGateDecision();
      expect(gateDecision?.decision).toBe('reject');
      expect(gateDecision?.reason).toContain('regression');
      expect(gateDecision?.reason).toContain('held_out');

      const commit = new CommitOperator(stubServer, stubVersions, false, { enabled: true });
      commit.setGateDecision(gateDecision);
      const commitResult = await commit.execute(createEmptyEvolvableState(), evalResult.output);

      expect(commitResult.output.accepted).toBe(false);
      expect(commitResult.output.reason).toContain('Acceptance gate rejected');
    },
    E2E_TIMEOUT
  );

  it(
    'gate math matches a direct runAcceptanceGate call on the same splits',
    async () => {
      const baselineSplits = await evaluateBothSplits(makeBackend(new Set(['t3'])));
      const candidateSplits = await evaluateBothSplits(makeBackend(new Set()));

      const decision = runAcceptanceGate(baselineSplits, candidateSplits, { repeats: 1 });
      expect(decision.decision).toBe('accept');
      expect(decision.format).toBe('kc.acceptance_gate.v1');
      const heldIn = decision.splits.find(s => s.split === 'held_in');
      expect(heldIn?.delta).toBeCloseTo(1 / 3, 9);
    },
    E2E_TIMEOUT
  );
});
