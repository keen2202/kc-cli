/**
 * Deterministic mock long-task evaluator backend (T5).
 *
 * Reuses the T1 fixture tasks + evaluation rules from
 * scripts/eval/agent-longtask-harness.mjs (ported to TypeScript so the lab
 * can call it in-process and unit-test isolation / budget / pin injection).
 *
 * Same inputs → same SplitResult. No network, no wall-clock in metric fields
 * (TaskResult.timestamp is pinned to 0). createdAt in meta.json is metadata only.
 *
 * Isolation (see evaluator-backend.ts):
 * - Eval set files and fixture sources are never written.
 * - Each task runs in a fresh temp copy; the copy is always removed.
 * - Variant pin is recorded + exposed via env convention for child processes;
 *   mock evaluation itself only consults pin.payload.mockTaskOverrides
 *   (the T5 mock injection point — T9 wires the real QueryEngine path).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  TASK_RESULT_FORMAT,
  aggregateSplitResult,
  truncateStdout,
  type EvalSet,
  type EvalTask,
  type MockTaskConfig,
  type SplitResult,
  type TaskResult,
} from '../eval/metrics';
import {
  buildVariantPinEnv,
  defaultRunsRoot,
  ensureRunDir,
  makeRunId,
  type EvalOptions,
  type EvalRunResult,
  type EvalSplit,
  type EvaluatorBackend,
  type VariantPin,
} from './evaluator-backend';

/** Mock-only pin payload. Real backends ignore this field. */
export interface MockVariantPayload {
  /**
   * Per-task mock config overrides. Keys are taskId.
   * This is the T5 injection point: a candidate can declare different mock
   * behavior so the evaluate → gate pipeline can be exercised end-to-end
   * without a real provider. Source fixtures and eval sets stay untouched —
   * overrides only affect the isolated workdir copy.
   */
  mockTaskOverrides?: Record<string, Partial<MockTaskConfig>>;
}

export interface MockLongtaskBackendOptions {
  /** Root used to resolve `local:` fixture repos. Default: process.cwd() */
  root?: string;
  /** Default runs root. Default: <root>/.kc-cli/experiments/eval-runs */
  runsRoot?: string;
  /**
   * Parent directory for per-task isolated workspaces.
   * Default: os.tmpdir(). Tests pass a dedicated dir to assert cleanup.
   */
  workDirParent?: string;
}

interface TaskEvalOutcome {
  result: TaskResult;
  patchBody: string;
  costUsd: number;
}

function resolveFixtureDir(repo: string, root: string): string {
  const rel = repo.startsWith('local:') ? repo.slice('local:'.length) : repo;
  return path.isAbsolute(rel) ? rel : path.join(root, rel);
}

function applyMockConfig(task: EvalTask, pin: VariantPin | null): MockTaskConfig {
  const base: MockTaskConfig = task.mock ?? { mode: 'no-patch', turns: 1, costUsd: 0 };
  const payload = pin?.payload as MockVariantPayload | undefined;
  const over = payload?.mockTaskOverrides?.[task.taskId];
  if (!over) return base;
  const merged: MockTaskConfig = {
    mode: over.mode ?? base.mode,
    turns: over.turns ?? base.turns,
    costUsd: over.costUsd ?? base.costUsd,
  };
  const patchFiles = over.patchFiles ?? base.patchFiles;
  if (patchFiles) merged.patchFiles = patchFiles;
  return merged;
}

/**
 * Evaluate one task inside a fresh temp copy of its fixture.
 * Mirrors evaluateTaskMock in agent-longtask-harness.mjs.
 */
function evaluateTaskMock(
  task: EvalTask,
  ctx: {
    runId: string;
    split: EvalSplit['name'];
    backend: string;
    pin: VariantPin | null;
    root: string;
    workDirParent: string;
  },
): TaskEvalOutcome {
  const mock = applyMockConfig(task, ctx.pin);
  const fixtureDir = resolveFixtureDir(task.repo, ctx.root);
  if (!fs.existsSync(fixtureDir)) {
    throw new Error(`fixture not found: ${fixtureDir}`);
  }

  fs.mkdirSync(ctx.workDirParent, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(ctx.workDirParent, 'kc-eval-task-'));
  let verificationExitCode: number | null = null;
  let stdout = '';
  let stderr = '';
  let patchBody = '';
  const patchFiles: string[] = [];
  let errorCode: string | null = null;

  try {
    // Isolated copy — candidate patches never touch the source fixture.
    fs.cpSync(fixtureDir, workDir, { recursive: true });

    if (mock.mode === 'apply-patch' && Array.isArray(mock.patchFiles)) {
      for (const file of mock.patchFiles) {
        const target = path.join(workDir, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const prev = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
        fs.writeFileSync(target, file.content, 'utf8');
        patchFiles.push(file.path);
        patchBody += `--- a/${file.path}\n+++ b/${file.path}\n`;
        if (prev !== null) patchBody += `-${prev.split('\n').join('\n-')}\n`;
        patchBody += `+${file.content.split('\n').join('\n+')}\n`;
      }
    }

    const noPatch = patchFiles.length === 0;
    let verified = false;

    if (!noPatch && task.verificationCommand) {
      const result = spawnSync(task.verificationCommand, {
        cwd: workDir,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        timeout: Math.max(1, Math.floor(task.timeoutSec * 1000)),
        // Inject pin env into the child only — never mutate process.env.
        env: { ...process.env, ...buildVariantPinEnv(ctx.pin) },
      });
      verificationExitCode = typeof result.status === 'number' ? result.status : 1;
      stdout = result.stdout ?? '';
      stderr = result.stderr ?? '';
      const timedOut =
        result.error !== undefined &&
        (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
      if (timedOut) {
        errorCode = 'timeout';
        verified = false;
      } else {
        verified = verificationExitCode === 0;
      }
    }

    let turns = Math.min(mock.turns, task.maxTurns);
    const costUsd = mock.costUsd;
    if (errorCode === null) {
      if (mock.turns > task.maxTurns) errorCode = 'max_turns';
      if (mock.costUsd > task.maxBudgetUsd) errorCode = 'budget_exceeded';
    }
    turns = Math.min(turns, task.maxTurns);

    const excerpt = truncateStdout(
      [stdout, stderr ? `# stderr\n${stderr}` : ''].filter(Boolean).join('\n'),
    );

    return {
      result: {
        format: TASK_RESULT_FORMAT,
        taskId: task.taskId,
        split: ctx.split,
        backend: ctx.backend,
        runId: ctx.runId,
        repo: task.repo,
        commit: task.commit,
        success: errorCode === null,
        verified,
        noPatch,
        turns,
        costUsd,
        patchFiles,
        verificationCommand: task.verificationCommand,
        verificationExitCode,
        safetyViolations: 0,
        errorCode,
        stdoutExcerpt: excerpt,
        timestamp: 0, // deterministic: mock metrics carry no wall clock
      },
      patchBody,
      costUsd,
    };
  } finally {
    // Isolated workspace cleanup — always, including on throw.
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function failedTaskResult(
  task: EvalTask,
  ctx: { runId: string; split: EvalSplit['name']; backend: string },
  errorCode: string,
  message: string,
): TaskResult {
  return {
    format: TASK_RESULT_FORMAT,
    taskId: task.taskId,
    split: ctx.split,
    backend: ctx.backend,
    runId: ctx.runId,
    repo: task.repo,
    commit: task.commit,
    success: false,
    verified: false,
    noPatch: true,
    turns: 0,
    costUsd: 0,
    patchFiles: [],
    verificationCommand: task.verificationCommand,
    verificationExitCode: null,
    safetyViolations: 0,
    errorCode,
    stdoutExcerpt: truncateStdout(message),
    timestamp: 0,
  };
}

function writeTaskArtifacts(
  evalRunDir: string,
  result: TaskResult,
  patchBody: string,
): string {
  const taskDir = path.join(evalRunDir, 'tasks', result.taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, 'record.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(taskDir, 'patch.diff'), patchBody, 'utf8');
  fs.writeFileSync(path.join(taskDir, 'stdout.txt'), result.stdoutExcerpt ?? '', 'utf8');
  return taskDir;
}

/** Persist split-*.json + summary.json (summary keeps a splits map for metrics.ts). */
function writeRunSummary(
  runDir: string,
  runId: string,
  backendName: string,
  splitName: EvalSplit['name'],
  split: SplitResult,
): void {
  fs.writeFileSync(
    path.join(runDir, `split-${splitName}.json`),
    JSON.stringify(split, null, 2),
    'utf8',
  );
  const summaryPath = path.join(runDir, 'summary.json');
  let existing: { splits?: Record<string, SplitResult> } = {};
  if (fs.existsSync(summaryPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(summaryPath, 'utf8')) as {
        splits?: Record<string, SplitResult>;
      };
    } catch {
      existing = {};
    }
  }
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        runId,
        backend: backendName,
        createdAt: new Date().toISOString(),
        splits: { ...(existing.splits ?? {}), [splitName]: split },
      },
      null,
      2,
    ),
    'utf8',
  );
}

export function createMockLongtaskBackend(
  options: MockLongtaskBackendOptions = {},
): EvaluatorBackend {
  const root = options.root ?? process.cwd();
  const defaultRoot = options.runsRoot ?? defaultRunsRoot(root);
  const workDirParent = options.workDirParent ?? os.tmpdir();
  const name = 'mock-longtask';

  async function evaluate(
    pin: VariantPin | null,
    split: EvalSplit,
    opts: EvalOptions = {},
  ): Promise<EvalRunResult> {
    const startedAt = Date.now();
    const timeoutMs =
      opts.timeoutSec !== undefined && opts.timeoutSec > 0
        ? opts.timeoutSec * 1000
        : null;
    const budgetCap = opts.maxBudgetUsd ?? null;

    if (!split.set.tasks || split.set.tasks.length === 0) {
      return {
        status: 'blocked',
        reason: 'eval split has no tasks',
        backend: name,
        partial: [],
      };
    }

    const runId = makeRunId(name, opts.runId);
    const runsRoot = opts.runsRoot ?? defaultRoot;
    let runDir: string;
    try {
      runDir = ensureRunDir(runsRoot, runId);
    } catch (err) {
      return {
        status: 'blocked',
        reason: `cannot create run dir: ${err instanceof Error ? err.message : String(err)}`,
        backend: name,
        partial: [],
      };
    }

    const variantEnv = buildVariantPinEnv(pin);
    const meta = {
      runId,
      backend: name,
      createdAt: new Date().toISOString(),
      split: split.name,
      setSource: split.sourcePath ?? null,
      pin: pin
        ? {
            artifactId: pin.artifactId,
            variantId: pin.variantId,
            baseHash: pin.baseHash,
            evidenceRef: pin.evidenceRef ?? null,
          }
        : null,
      variantEnv,
      isolation: {
        workDirParent,
        note:
          'eval sets/fixtures are read-only; each task runs in a temp copy that is always removed; ' +
          'pin env is passed via child-process env only (process.env is never mutated)',
      },
      note: 'mock backend is deterministic; createdAt is metadata only',
    };
    fs.writeFileSync(
      path.join(runDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf8',
    );

    const tasks: TaskResult[] = [];
    let cumulativeCost = 0;

    for (const task of split.set.tasks) {
      // Run-level caps → stop remaining tasks, return blocked + partial.
      if (timeoutMs !== null && Date.now() - startedAt >= timeoutMs) {
        writeRunSummary(runDir, runId, name, split.name, aggregateSplitResult(tasks));
        return {
          status: 'blocked',
          reason: `run-level timeout exceeded (${opts.timeoutSec}s)`,
          backend: name,
          partial: tasks,
        };
      }
      if (budgetCap !== null && cumulativeCost > budgetCap) {
        writeRunSummary(runDir, runId, name, split.name, aggregateSplitResult(tasks));
        return {
          status: 'blocked',
          reason: `run-level budget exceeded (${budgetCap} USD)`,
          backend: name,
          partial: tasks,
        };
      }

      let outcome: TaskEvalOutcome;
      try {
        outcome = evaluateTaskMock(task, {
          runId,
          split: split.name,
          backend: name,
          pin,
          root,
          workDirParent,
        });
      } catch (err) {
        // Single-task failure must not pollute siblings.
        const message = err instanceof Error ? err.message : String(err);
        const failed = failedTaskResult(
          task,
          { runId, split: split.name, backend: name },
          'eval_error',
          message,
        );
        writeTaskArtifacts(runDir, failed, '');
        tasks.push(failed);
        continue;
      }

      writeTaskArtifacts(runDir, outcome.result, outcome.patchBody);
      tasks.push(outcome.result);
      cumulativeCost += outcome.costUsd;
    }

    // Final budget check (last task may have crossed the cap).
    if (budgetCap !== null && cumulativeCost > budgetCap) {
      writeRunSummary(runDir, runId, name, split.name, aggregateSplitResult(tasks));
      return {
        status: 'blocked',
        reason: `run-level budget exceeded (${budgetCap} USD after ${tasks.length} task(s))`,
        backend: name,
        partial: tasks,
      };
    }

    const aggregated: SplitResult = aggregateSplitResult(tasks);
    writeRunSummary(runDir, runId, name, split.name, aggregated);

    return {
      status: 'ok',
      runId,
      backend: name,
      pin,
      splitName: split.name,
      split: aggregated,
      tasks,
      runDir,
    };
  }

  return { name, evaluate };
}

/** Load a split from a frozen set file (lab-side helper). */
export function loadEvalSplit(
  setPath: string,
  parse: (raw: string) => EvalSet,
): EvalSplit {
  const raw = fs.readFileSync(setPath, 'utf8');
  const set = parse(raw);
  return { name: set.split, set, sourcePath: path.resolve(setPath) };
}
