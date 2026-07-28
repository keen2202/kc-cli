/**
 * EvaluatorBackend tests (harness-evolution T5).
 *
 * Covers eval-set validation/loading, SplitResult assembly through a
 * MockShell, semaphore-bounded concurrency, budget enforcement, and the
 * EvaluateOperator injection point (heuristic path unchanged when no
 * backend is injected).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  VitestEvaluatorBackend,
  validateEvolutionEvalConfig,
  loadEvolutionEvalConfig,
} from '../../src/agp/sepl/evaluator-vitest';
import { EvaluateOperator } from '../../src/agp/sepl/evaluate';
import { createEmptyEvolvableState } from '../../src/agp/sepl/protocol';
import type {
  EvolutionEvalConfig,
  EvaluatorBackend,
  Modification,
  ObjectiveSpec,
  SplitResult,
} from '../../src/agp/sepl/protocol';
import { MockShell } from '../../src/services/execution-env-mock';
import { TraceManager } from '../../src/agp/trace-manager';
import { BudgetEnforcer } from '../../src/services/budget';
import { KCError } from '../../src/utils/errors';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const evalConfig: EvolutionEvalConfig = {
  format: 'kc.evolution_eval.v1',
  heldIn: ['test/a.test.ts', 'test/b.test.ts', 'test/c.test.ts'],
  heldOut: ['test/d.test.ts', 'test/e.test.ts'],
  repeats: 2,
};

const objective: ObjectiveSpec = {
  primaryMetric: 'success_rate',
  minimumThreshold: 0.5,
  safetyConstraints: [],
};

function makeModification(overrides: Partial<Modification> = {}): Modification {
  return {
    id: 'mod-1',
    hypothesisId: 'hyp-1',
    targetResource: 'Prompt:test-prompt',
    resourceType: 'Prompt' as Modification['resourceType'],
    changeType: 'template_rewrite',
    proposedValue: 'new template',
    estimatedImpact: 0.6,
    riskLevel: 'low',
    ...overrides,
  };
}

/** Fixed-shape SplitResult helper matching evalConfig denominators. */
function splitOf(split: 'held_in' | 'held_out', passed: number, total: number): SplitResult {
  return {
    split,
    repeats: [
      { repeat: 0, passed, total },
      { repeat: 1, passed, total },
    ],
  };
}

// ─── Eval-set validation ─────────────────────────────────────────────────────

describe('validateEvolutionEvalConfig', () => {
  it('accepts a well-formed config and returns a defensive copy', () => {
    const validated = validateEvolutionEvalConfig(evalConfig);
    expect(validated).toEqual(evalConfig);
    expect(validated.heldIn).not.toBe(evalConfig.heldIn);
  });

  it('rejects unknown formats', () => {
    expect(() => validateEvolutionEvalConfig({ ...evalConfig, format: 'v0' as never }))
      .toThrowError(/unsupported format/);
  });

  it('rejects empty task lists', () => {
    expect(() => validateEvolutionEvalConfig({ ...evalConfig, heldOut: [] }))
      .toThrowError(/heldOut must be a non-empty array/);
  });

  it('rejects overlapping held-in/held-out lists', () => {
    expect(() => validateEvolutionEvalConfig({ ...evalConfig, heldOut: ['test/a.test.ts'] }))
      .toThrowError(/must be disjoint/);
  });

  it('rejects non-positive repeats', () => {
    expect(() => validateEvolutionEvalConfig({ ...evalConfig, repeats: 0 }))
      .toThrowError(/repeats must be a positive integer/);
  });
});

describe('loadEvolutionEvalConfig', () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('loads and validates a config file from disk', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-eval-'));
    const filePath = path.join(tmpDir, 'evolution-eval.json');
    fs.writeFileSync(filePath, JSON.stringify(evalConfig), 'utf8');
    expect(loadEvolutionEvalConfig(filePath)).toEqual(evalConfig);
  });

  it('ships a valid example config in .kc-cli/', () => {
    const example = loadEvolutionEvalConfig(
      path.join(process.cwd(), '.kc-cli', 'evolution-eval-example.json')
    );
    expect(example.format).toBe('kc.evolution_eval.v1');
    expect(example.heldIn.length).toBeGreaterThan(0);
    expect(example.heldOut.length).toBeGreaterThan(0);
  });
});

// ─── VitestEvaluatorBackend ──────────────────────────────────────────────────

describe('VitestEvaluatorBackend', () => {
  it('assembles SplitResult from per-task exit codes over fixed repeats', async () => {
    const shell = new MockShell();
    shell.on(/b\.test\.ts/, () => ({ stdout: '', stderr: 'FAIL', exitCode: 1 }));

    const backend = new VitestEvaluatorBackend({ shell, evalConfig });
    const result = await backend.evaluate(createEmptyEvolvableState(), 'held_in');

    expect(result).toEqual({
      split: 'held_in',
      repeats: [
        { repeat: 0, passed: 2, total: 3 },
        { repeat: 1, passed: 2, total: 3 },
      ],
    });
    // 3 tasks × 2 repeats, default vitest command
    expect(shell.executedCommands).toHaveLength(6);
    expect(shell.executedCommands[0].command).toContain('npx vitest run');
  });

  it('uses the held-out task list for the held_out split', async () => {
    const shell = new MockShell();
    const backend = new VitestEvaluatorBackend({ shell, evalConfig });
    const result = await backend.evaluate(createEmptyEvolvableState(), 'held_out', { repeats: 1 });

    expect(result.repeats).toEqual([{ repeat: 0, passed: 2, total: 2 }]);
    expect(shell.executedCommands.map(c => c.command).join(' ')).toContain('test/d.test.ts');
  });

  it('respects a custom buildCommand', async () => {
    const shell = new MockShell();
    const backend = new VitestEvaluatorBackend({
      shell,
      evalConfig,
      buildCommand: task => `run-task ${task}`,
    });
    await backend.evaluate(createEmptyEvolvableState(), 'held_in', { repeats: 1 });
    expect(shell.executedCommands[0].command).toBe('run-task test/a.test.ts');
  });

  it('bounds parallel task execution with the semaphore', async () => {
    const shell = new MockShell();
    let inFlight = 0;
    let maxInFlight = 0;
    shell.setDefault({ stdout: '', stderr: '', exitCode: 0 });
    shell.on(/./, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 10));
      inFlight--;
      return { stdout: '', stderr: '', exitCode: 0 };
    });

    const backend = new VitestEvaluatorBackend({ shell, evalConfig, concurrency: 2 });
    await backend.evaluate(createEmptyEvolvableState(), 'held_in', { repeats: 1 });

    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(shell.executedCommands).toHaveLength(3);
  });

  it('aborts with budget_exceeded when the budget denies a task run', async () => {
    const shell = new MockShell();
    const budget = new BudgetEnforcer({ subAgentTokenLimit: 10 });
    const backend = new VitestEvaluatorBackend({
      shell,
      evalConfig,
      budget,
      estimatedTokensPerTask: 100,
    });

    await expect(
      backend.evaluate(createEmptyEvolvableState(), 'held_in', { repeats: 1 })
    ).rejects.toSatisfy(e => e instanceof KCError && e.code === 'budget_exceeded');
  });

  it('records budget usage per executed task', async () => {
    const shell = new MockShell();
    const budget = new BudgetEnforcer({ subAgentTokenLimit: 1000, sessionTokenLimit: 1000 });
    const backend = new VitestEvaluatorBackend({
      shell,
      evalConfig,
      budget,
      estimatedTokensPerTask: 10,
    });
    await backend.evaluate(createEmptyEvolvableState(), 'held_in', { repeats: 2 });
    expect(budget.getSessionUsage().tokens).toBe(60); // 3 tasks × 2 repeats × 10
  });
});

// ─── EvaluateOperator injection point ────────────────────────────────────────

describe('EvaluateOperator backend injection', () => {
  const traceManager = new TraceManager();

  it('keeps the heuristic path when no backend is injected', async () => {
    const op = new EvaluateOperator(objective, traceManager);
    const result = await op.execute(createEmptyEvolvableState(), {
      modifications: [makeModification()],
      sourceHypothesisId: 'hyp-1',
    });

    expect(result.success).toBe(true);
    // Heuristic scoring path: score derives from estimatedImpact, no gate
    expect(result.output.results[0].primaryScore).toBeGreaterThan(0);
    expect(op.getLastGateDecision()).toBeNull();
  });

  it('scores via the backend and gates against baseline splits', async () => {
    const backend: EvaluatorBackend = {
      name: 'stub',
      evaluate: async (_state, split) =>
        split === 'held_in' ? splitOf('held_in', 3, 3) : splitOf('held_out', 2, 2),
    };
    const op = new EvaluateOperator(objective, traceManager, {}, backend);
    op.setBaselineSplits([splitOf('held_in', 2, 3), splitOf('held_out', 2, 2)]);

    const result = await op.execute(createEmptyEvolvableState(), {
      modifications: [makeModification()],
      sourceHypothesisId: 'hyp-1',
    });

    expect(result.success).toBe(true);
    expect(result.output.results[0].accepted).toBe(true);
    expect(result.output.bestCandidateIndex).toBe(0);
    expect(op.getLastGateDecision()?.decision).toBe('accept');
    expect(result.output.results[0].summary).toContain('backend=stub');
  });

  it('rejects candidates when the gate detects a regression', async () => {
    const backend: EvaluatorBackend = {
      name: 'stub',
      evaluate: async (_state, split) =>
        split === 'held_in' ? splitOf('held_in', 3, 3) : splitOf('held_out', 1, 2),
    };
    const op = new EvaluateOperator(objective, traceManager);
    op.setEvaluatorBackend(backend);
    op.setBaselineSplits([splitOf('held_in', 2, 3), splitOf('held_out', 2, 2)]);

    const result = await op.execute(createEmptyEvolvableState(), {
      modifications: [makeModification()],
      sourceHypothesisId: 'hyp-1',
    });

    expect(result.output.results[0].accepted).toBe(false);
    expect(result.output.bestCandidateIndex).toBe(-1);
    expect(op.getLastGateDecision()?.decision).toBe('reject');
    expect(result.output.results[0].summary).toContain('gate:');
  });

  it('falls back to the threshold rule without baseline splits', async () => {
    const backend: EvaluatorBackend = {
      name: 'stub',
      evaluate: async (_state, split) => splitOf(split, 1, 3), // pass rate ≈ 0.33 < 0.5
    };
    const op = new EvaluateOperator(objective, traceManager, {}, backend);

    const result = await op.execute(createEmptyEvolvableState(), {
      modifications: [makeModification()],
      sourceHypothesisId: 'hyp-1',
    });

    expect(result.output.results[0].accepted).toBe(false);
    expect(op.getLastGateDecision()).toBeNull();
  });

  it('surfaces incomparable baselines as an operator failure, not a crash', async () => {
    const backend: EvaluatorBackend = {
      name: 'stub',
      evaluate: async (_state, split) => splitOf(split, 3, 5), // total=5 vs baseline total=3
    };
    const op = new EvaluateOperator(objective, traceManager, {}, backend);
    op.setBaselineSplits([splitOf('held_in', 2, 3), splitOf('held_out', 2, 3)]);

    const result = await op.execute(createEmptyEvolvableState(), {
      modifications: [makeModification()],
      sourceHypothesisId: 'hyp-1',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('repeat sequences differ');
  });
});
