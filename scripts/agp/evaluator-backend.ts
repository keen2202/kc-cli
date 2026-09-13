/**
 * Evaluator backend contracts for the offline AGP lab (T5).
 *
 * Spec: docs/specs/agp-experiment-runtime-spec.md §3.6 / §4.4
 *
 * Offline lab only — never imported by src/**.
 * SplitResult / TaskResult shapes are re-exported from scripts/eval/metrics.ts
 * so baseline (T1 harness) and lab evaluators stay byte-compatible.
 *
 * ── Run isolation (non-negotiable) ────────────────────────────────────────
 * 1. Candidates must not write eval task sets, fixtures, or evaluator code.
 *    Backends treat split.set / set files as read-only inputs.
 * 2. Every task executes inside a fresh temp copy of its fixture workspace.
 *    The copy is removed even when the task fails.
 * 3. Network / wall-clock / budget follow the task manifest
 *    (timeoutSec, maxBudgetUsd) and optional run-level EvalOptions caps.
 * 4. A single task failure is recorded as a TaskResult and must not abort
 *    or mutate sibling tasks.
 *
 * ── Variant pin injection (T5 types only; T9 wires QueryEngine) ───────────
 *   KC_EXPERIMENTS_ENABLED=1
 *   KC_EXPERIMENT_VARIANT_OVERRIDE={"<artifactId>":"<variantId>"}
 *   KC_EXPERIMENT_TASK_ID=<taskId>          (optional, per task)
 *
 * Backends MUST pass these via the child-process `env` option and MUST NOT
 * mutate process.env. Evaluation结束后不残留 ambient override（父进程 env
 * 从未被改写；baseline 指针由 catalog/runtime 默认路径保证）。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  EvalSet,
  EvalTask,
  SplitResult,
  TaskResult,
} from '../eval/metrics';

export type { EvalSet, EvalTask, SplitResult, TaskResult };

/** Pin one evaluation arm to baseline or a candidate variant. */
export interface VariantPin {
  /** e.g. `prompt-surface:failure-recovery` */
  artifactId: string;
  /** null = baseline (code default). */
  variantId: string | null;
  /** SHA-256 of the canonical baseline the variant was built against. */
  baseHash: string;
  /** Optional immutable evidence hash (T3 evidence-store). */
  evidenceRef?: string;
  /**
   * Backend-specific injection payload.
   * - mock-longtask-backend: optional MockVariantPayload (see mock backend).
   * - swebench / real backends: opaque; applied via production ExperimentRuntime,
   *   never by re-concatenating prompts inside the evaluator.
   */
  payload?: unknown;
}

/** A frozen split ready for evaluation. Sets are read-only to candidates. */
export interface EvalSplit {
  name: 'held-in' | 'held-out';
  set: EvalSet;
  /** Absolute path of the source set file (audit / evidence). */
  sourcePath?: string;
}

/** Env keys used to inject a variant pin into a child process. */
export const VARIANT_PIN_ENV = {
  enabled: 'KC_EXPERIMENTS_ENABLED',
  override: 'KC_EXPERIMENT_VARIANT_OVERRIDE',
  taskId: 'KC_EXPERIMENT_TASK_ID',
} as const;

export type VariantPinEnv = Readonly<Record<string, string>>;

/**
 * Build the child-process env overlay for a pin.
 * - pin=null or variantId=null → force experiments off (baseline arm).
 * - otherwise → enable + JSON per-run override keyed by artifactId.
 *
 * T5 only defines the convention and this builder; QueryEngine consumption
 * of the same env keys lands in T9.
 */
export function buildVariantPinEnv(pin: VariantPin | null): VariantPinEnv {
  if (!pin || pin.variantId === null) {
    return { [VARIANT_PIN_ENV.enabled]: '0' };
  }
  const override: Record<string, string> = {
    [pin.artifactId]: pin.variantId,
  };
  return {
    [VARIANT_PIN_ENV.enabled]: '1',
    [VARIANT_PIN_ENV.override]: JSON.stringify(override),
  };
}

export interface EvalOptions {
  /** Artifact root. Default: <cwd>/.kc-cli/experiments/eval-runs */
  runsRoot?: string;
  /** Explicit run directory name. Default: generated. */
  runId?: string;
  /**
   * Hard wall-clock cap for the whole evaluate() call, in seconds.
   * When exceeded the backend stops remaining tasks and returns blocked
   * with whatever partial TaskResults were already collected.
   */
  timeoutSec?: number;
  /**
   * Hard cumulative cost cap (USD) for the whole evaluate() call.
   * When exceeded → blocked (same partial-result semantics as timeout).
   */
  maxBudgetUsd?: number;
  /** Reserved for T6 gate (repeats >= 3). Default 1. */
  repeats?: number;
}

export type EvalRunStatus = 'ok' | 'blocked';

export interface EvalRunBlocked {
  status: 'blocked';
  reason: string;
  backend: string;
  /** Task records collected before the block (may be empty). */
  partial: TaskResult[];
}

export interface EvalRunOk {
  status: 'ok';
  runId: string;
  backend: string;
  pin: VariantPin | null;
  splitName: EvalSplit['name'];
  split: SplitResult;
  tasks: TaskResult[];
  /** Absolute path of `.kc-cli/experiments/eval-runs/<runId>/` (or override). */
  runDir: string;
}

export type EvalRunResult = EvalRunOk | EvalRunBlocked;

export interface EvaluatorBackend {
  readonly name: string;
  /**
   * Run every task in `split` under `pin` and return aggregated SplitResult.
   *
   * Contract:
   * - read-only w.r.t. eval sets / fixtures / evaluator sources
   * - per-task isolated temp workspace, always cleaned up
   * - single-task failure does not abort siblings
   * - run-level budget/timeout → status 'blocked' + partial results
   */
  evaluate(
    pin: VariantPin | null,
    split: EvalSplit,
    opts?: EvalOptions,
  ): Promise<EvalRunResult>;
}

/**
 * Run baseline and candidate arms on the same split.
 * Convenience helper only — the non-regression decision is T6's acceptance
 * gate, not this function.
 *
 * When opts.runId is set, arms are written to `<runId>-baseline` and
 * `<runId>-candidate` so artifacts never overwrite each other.
 */
export async function evaluatePair(
  backend: EvaluatorBackend,
  candidatePin: VariantPin,
  split: EvalSplit,
  opts?: EvalOptions,
): Promise<{ baseline: EvalRunResult; candidate: EvalRunResult }> {
  const baseId = opts?.runId?.trim();
  const baselineOpts: EvalOptions = {
    ...opts,
    runId: baseId ? `${baseId}-baseline` : undefined,
  };
  const candidateOpts: EvalOptions = {
    ...opts,
    runId: baseId ? `${baseId}-candidate` : undefined,
  };
  const baseline = await backend.evaluate(null, split, baselineOpts);
  const candidate = await backend.evaluate(candidatePin, split, candidateOpts);
  return { baseline, candidate };
}

/** Default eval-runs root (mirrors scripts/eval harness). */
export function defaultRunsRoot(cwd: string = process.cwd()): string {
  return path.join(cwd, '.kc-cli', 'experiments', 'eval-runs');
}

/** Create `<runsRoot>/<runId>/` and return both. */
export function ensureRunDir(runsRoot: string, runId: string): string {
  const runDir = path.join(runsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

/** Unique-but-stable-enough run id (metadata only; metrics stay deterministic). */
export function makeRunId(backend: string, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  return `${backend}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}
