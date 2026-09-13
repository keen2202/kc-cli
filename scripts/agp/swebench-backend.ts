/**
 * SWE-bench evaluator backend skeleton (T5).
 *
 * Spec §4.4: wrap `evaluation/swe_bench/adapter.ts`, one worktree per
 * instance, inject variant pin via production runtime (never re-concatenate
 * prompts inside the evaluator).
 *
 * As of T5 the adapter path does not exist in this repository. evaluate()
 * therefore always returns `{ status: 'blocked', reason }` — per §4.5 an
 * unavailable backend must block the gate rather than invent metrics.
 *
 * When the adapter lands, this file should:
 *   1. Resolve ADAPTER_PATH (fs.existsSync / dynamic import).
 *   2. For each instance: create a fresh worktree from instance.commit.
 *   3. Spawn the agent with buildVariantPinEnv(pin) in the child env
 *      (KC_EXPERIMENTS_ENABLED + KC_EXPERIMENT_VARIANT_OVERRIDE).
 *   4. Collect patch file list + FAIL_TO_PASS / PASS_TO_PASS results.
 *   5. Map to TaskResult (kc.eval_task_result.v1) and aggregate SplitResult.
 *   6. Tear down every worktree even on task failure.
 *
 * Offline lab only — never imported by src/**.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  EvalOptions,
  EvalRunResult,
  EvalSplit,
  EvaluatorBackend,
  VariantPin,
} from './evaluator-backend';

/**
 * Candidate adapter locations. The first existing file wins.
 * Paths are relative to this module (scripts/agp/ → repo root).
 */
export const ADAPTER_CANDIDATES = [
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../evaluation/swe_bench/adapter.ts',
  ),
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../evaluation/swe_bench/adapter.js',
  ),
] as const;

/** True when a SWE-bench adapter is present on disk. */
export function findSwebenchAdapter(): string | null {
  for (const candidate of ADAPTER_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function createSwebenchBackend(): EvaluatorBackend {
  const name = 'swebench';

  async function evaluate(
    _pin: VariantPin | null,
    _split: EvalSplit,
    _opts?: EvalOptions,
  ): Promise<EvalRunResult> {
    const adapter = findSwebenchAdapter();
    if (!adapter) {
      return {
        status: 'blocked',
        reason:
          'evaluation/swe_bench/adapter.ts not found — SWE-bench backend is a T5 skeleton; ' +
          'see scripts/agp/swebench-backend.ts header for the integration contract. ' +
          'Per spec §4.5 an unavailable backend blocks the gate (no metrics invented).',
        backend: name,
        partial: [],
      };
    }

    // Adapter exists but the wiring is intentionally not implemented in T5.
    // Returning blocked keeps the gate honest until a real integration lands.
    return {
      status: 'blocked',
      reason:
        `SWE-bench adapter found at ${adapter} but evaluate() wiring is not implemented in T5. ` +
        'Implement worktree-per-instance + production-runtime pin injection before use.',
      backend: name,
      partial: [],
    };
  }

  return { name, evaluate };
}
