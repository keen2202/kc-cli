/**
 * Vitest-backed EvaluatorBackend (T5 / H5).
 *
 * Runs a fixed subset of project tests as the verifier for a candidate
 * state. Each task executes through `ExecutionEnv.Shell` in its own child
 * process (fresh environment per run — sandbox wrapping comes from the
 * injected Shell implementation); concurrency is bounded by a semaphore
 * and spend is bounded by the optional budget enforcer.
 *
 * The held-in / held-out task lists come from `.kc-cli/evolution-eval.json`
 * and are fixed before a run, identical across all candidates, so the T4
 * acceptance gate's denominator-consistency check holds by construction.
 */

import * as fs from 'node:fs';
import type { Shell } from '../../services/execution-env';
import type { BudgetEnforcer } from '../../services/budget';
import { createBudgetExceededError } from '../../services/budget';
import { Semaphore } from '../../utils/semaphore';
import type {
  EvaluatorBackend,
  EvaluatorBackendOptions,
  EvolutionEvalConfig,
  EvolvableState,
  EvalSplit,
  SplitResult,
  SplitRepeat,
} from './protocol';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_EVAL_CONFIG_PATH = '.kc-cli/evolution-eval.json';
const EVAL_CONFIG_FORMAT = 'kc.evolution_eval.v1';
const DEFAULT_REPEATS = 2;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_TASK_TIMEOUT_MS = 120_000;
/** Shell task runs consume no LLM tokens unless the caller says otherwise. */
const DEFAULT_ESTIMATED_TOKENS_PER_TASK = 0;

// ─── Eval-set loading ────────────────────────────────────────────────────────

/**
 * Validate a parsed evolution eval-set definition. Throws on malformed
 * input; returns a defensive copy on success.
 */
export function validateEvolutionEvalConfig(
  parsed: Partial<EvolutionEvalConfig>
): EvolutionEvalConfig {
  if (parsed.format !== EVAL_CONFIG_FORMAT) {
    throw new Error(
      `evolution eval config: unsupported format "${String(parsed.format)}" (expected "${EVAL_CONFIG_FORMAT}")`
    );
  }
  for (const key of ['heldIn', 'heldOut'] as const) {
    const list = parsed[key];
    if (!Array.isArray(list) || list.length === 0 || list.some(t => typeof t !== 'string' || t.length === 0)) {
      throw new Error(`evolution eval config: ${key} must be a non-empty array of task strings`);
    }
  }
  const heldIn = [...parsed.heldIn!];
  const heldOut = [...parsed.heldOut!];
  const overlap = heldIn.filter(task => heldOut.includes(task));
  if (overlap.length > 0) {
    throw new Error(`evolution eval config: heldIn and heldOut must be disjoint (shared: ${overlap.join(', ')})`);
  }
  if (parsed.repeats !== undefined && (!Number.isInteger(parsed.repeats) || parsed.repeats <= 0)) {
    throw new Error('evolution eval config: repeats must be a positive integer');
  }
  return { format: EVAL_CONFIG_FORMAT, heldIn, heldOut, repeats: parsed.repeats };
}

/** Load and validate the eval-set definition from disk. */
export function loadEvolutionEvalConfig(filePath: string = DEFAULT_EVAL_CONFIG_PATH): EvolutionEvalConfig {
  const raw = fs.readFileSync(filePath, 'utf8');
  return validateEvolutionEvalConfig(JSON.parse(raw) as Partial<EvolutionEvalConfig>);
}

// ─── Backend ─────────────────────────────────────────────────────────────────

export interface VitestEvaluatorOptions {
  /** Shell used to execute tasks (inject a sandboxed Shell to isolate runs) */
  shell: Shell;
  /** Fixed eval-set definition (see `loadEvolutionEvalConfig`) */
  evalConfig: EvolutionEvalConfig;
  /** Working directory for task execution */
  cwd?: string;
  /** Max concurrent task executions (semaphore permits, default 2) */
  concurrency?: number;
  /** Optional budget enforcer; a denied check aborts the evaluation */
  budget?: BudgetEnforcer;
  /** Token cost charged per task run when a budget is set (default 0) */
  estimatedTokensPerTask?: number;
  /** Override the command built for one task (default: `npx vitest run <task>`) */
  buildCommand?: (task: string) => string;
}

export class VitestEvaluatorBackend implements EvaluatorBackend {
  readonly name = 'vitest';

  private readonly shell: Shell;
  private readonly evalConfig: EvolutionEvalConfig;
  private readonly cwd: string | undefined;
  private readonly semaphore: Semaphore;
  private readonly budget: BudgetEnforcer | undefined;
  private readonly estimatedTokensPerTask: number;
  private readonly buildCommand: (task: string) => string;

  constructor(options: VitestEvaluatorOptions) {
    this.shell = options.shell;
    this.evalConfig = validateEvolutionEvalConfig(options.evalConfig);
    this.cwd = options.cwd;
    this.semaphore = new Semaphore(options.concurrency ?? DEFAULT_CONCURRENCY);
    this.budget = options.budget;
    this.estimatedTokensPerTask = options.estimatedTokensPerTask ?? DEFAULT_ESTIMATED_TOKENS_PER_TASK;
    this.buildCommand = options.buildCommand ?? defaultBuildCommand;
  }

  async evaluate(
    _candidateState: EvolvableState,
    split: EvalSplit,
    opts?: EvaluatorBackendOptions
  ): Promise<SplitResult> {
    const tasks = split === 'held_in' ? this.evalConfig.heldIn : this.evalConfig.heldOut;
    const repeats = opts?.repeats ?? this.evalConfig.repeats ?? DEFAULT_REPEATS;
    if (!Number.isInteger(repeats) || repeats <= 0) {
      throw new Error(`evaluator repeats must be a positive integer, got ${repeats}`);
    }

    const repeatResults: SplitRepeat[] = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      const outcomes = await Promise.all(
        tasks.map(task => this.semaphore.withPermit(() => this.runTask(task, opts)))
      );
      repeatResults.push({
        repeat,
        passed: outcomes.filter(Boolean).length,
        total: tasks.length,
      });
    }

    return { split, repeats: repeatResults };
  }

  /** Run one verification task; true = passed (exit code 0). */
  private async runTask(task: string, opts?: EvaluatorBackendOptions): Promise<boolean> {
    if (this.budget) {
      const check = this.budget.checkSubAgentBudget(this.estimatedTokensPerTask);
      if (!check.allowed) {
        throw createBudgetExceededError(check.reason ?? 'evaluation budget exceeded', { task });
      }
    }

    const result = await this.shell.exec(this.buildCommand(task), {
      cwd: this.cwd,
      timeout: opts?.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS,
      signal: opts?.signal,
    });

    this.budget?.recordUsage(this.estimatedTokensPerTask);
    return result.exitCode === 0;
  }
}

function defaultBuildCommand(task: string): string {
  return `npx vitest run ${JSON.stringify(task)}`;
}
