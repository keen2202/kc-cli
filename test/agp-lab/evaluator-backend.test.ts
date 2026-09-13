/**
 * AGP T5 — evaluator backend contracts + mock/swebench backends.
 *
 * Covers: mock repeat stability, isolated workspace cleanup, run-level
 * budget/timeout → blocked, patch/exit-code collection, variant-pin env,
 * single-task failure isolation, swebench blocked skeleton.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEvalSet, type EvalSet } from '../../scripts/eval/metrics';
import {
  buildVariantPinEnv,
  evaluatePair,
  makeRunId,
  type EvalSplit,
  type VariantPin,
} from '../../scripts/agp/evaluator-backend';
import {
  createMockLongtaskBackend,
  type MockVariantPayload,
} from '../../scripts/agp/mock-longtask-backend';
import {
  createSwebenchBackend,
  findSwebenchAdapter,
} from '../../scripts/agp/swebench-backend';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const HELD_IN = path.join(REPO_ROOT, 'scripts/eval/sets/longtask-held-in.json');
const HELD_OUT = path.join(REPO_ROOT, 'scripts/eval/sets/longtask-held-out.json');

let tmp: string;
let runsRoot: string;
let workDirParent: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agp-eval-be-'));
  runsRoot = path.join(tmp, 'eval-runs');
  workDirParent = path.join(tmp, 'workspaces');
  fs.mkdirSync(runsRoot, { recursive: true });
  fs.mkdirSync(workDirParent, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function loadSplit(setPath: string): EvalSplit {
  const set = loadEvalSet(setPath);
  return { name: set.split, set, sourcePath: setPath };
}

function backend() {
  return createMockLongtaskBackend({
    root: REPO_ROOT,
    runsRoot,
    workDirParent,
  });
}

const CANDIDATE: VariantPin = {
  artifactId: 'prompt-surface:failure-recovery',
  variantId: 'cand-001',
  baseHash: 'sha256:test',
  evidenceRef: 'sha256:ev1',
};

describe('agp-lab/evaluator-backend types', () => {
  it('buildVariantPinEnv: null pin forces experiments off', () => {
    expect(buildVariantPinEnv(null)).toEqual({ KC_EXPERIMENTS_ENABLED: '0' });
  });

  it('buildVariantPinEnv: baseline pin (variantId null) forces off', () => {
    const env = buildVariantPinEnv({
      artifactId: 'prompt-surface:failure-recovery',
      variantId: null,
      baseHash: 'sha256:b',
    });
    expect(env).toEqual({ KC_EXPERIMENTS_ENABLED: '0' });
  });

  it('buildVariantPinEnv: candidate pin sets enabled + JSON override', () => {
    const env = buildVariantPinEnv(CANDIDATE);
    expect(env.KC_EXPERIMENTS_ENABLED).toBe('1');
    expect(JSON.parse(env.KC_EXPERIMENT_VARIANT_OVERRIDE!)).toEqual({
      'prompt-surface:failure-recovery': 'cand-001',
    });
  });

  it('makeRunId uses explicit id or falls back to backend prefix', () => {
    expect(makeRunId('mock-longtask', 'fixed-run')).toBe('fixed-run');
    expect(makeRunId('mock-longtask')).toMatch(/^mock-longtask-/);
  });
});

describe('agp-lab/mock-longtask-backend', () => {
  it(
    'repeated runs produce identical SplitResult (deterministic)',
    async () => {
      const be = backend();
      const split = loadSplit(HELD_IN);

      const a = await be.evaluate(null, split, { runId: 'det-a' });
      const b = await be.evaluate(null, split, { runId: 'det-b' });

      expect(a.status).toBe('ok');
      expect(b.status).toBe('ok');
      if (a.status !== 'ok' || b.status !== 'ok') return;

      expect(a.split).toEqual(b.split);
      expect(a.split.tasks).toBe(split.set.tasks.length);
      expect(a.split.safetyViolations).toBe(0);
      // held-in includes a no-patch observe task
      expect(a.split.noPatchRate).toBeGreaterThan(0);
      // timestamps stay 0 for determinism
      for (const t of a.tasks) expect(t.timestamp).toBe(0);
    },
    30000,
  );

  it(
    'collects patch files, verification command, exit code, turns, cost, no-patch',
    async () => {
      const be = backend();
      const split = loadSplit(HELD_IN);
      const run = await be.evaluate(null, split, { runId: 'collect-1' });
      expect(run.status).toBe('ok');
      if (run.status !== 'ok') return;

      const greeting = run.tasks.find((t) => t.taskId === 'hi-write-greeting');
      expect(greeting).toBeDefined();
      expect(greeting!.verified).toBe(true);
      expect(greeting!.noPatch).toBe(false);
      expect(greeting!.patchFiles).toContain('greeting.txt');
      expect(greeting!.verificationCommand).toBe('node verify.mjs');
      expect(greeting!.verificationExitCode).toBe(0);
      expect(greeting!.turns).toBeGreaterThan(0);
      expect(greeting!.costUsd).toBeGreaterThan(0);

      const observe = run.tasks.find((t) => t.taskId === 'hi-no-patch-observe');
      expect(observe).toBeDefined();
      expect(observe!.noPatch).toBe(true);
      expect(observe!.verified).toBe(false);
      expect(observe!.patchFiles).toEqual([]);
      expect(observe!.verificationExitCode).toBeNull();

      // artifacts under eval-runs/<runId>/
      const taskDir = path.join(run.runDir, 'tasks', 'hi-write-greeting');
      expect(fs.existsSync(path.join(taskDir, 'record.json'))).toBe(true);
      expect(fs.existsSync(path.join(taskDir, 'patch.diff'))).toBe(true);
      expect(fs.existsSync(path.join(taskDir, 'stdout.txt'))).toBe(true);
      expect(fs.existsSync(path.join(run.runDir, 'meta.json'))).toBe(true);
      expect(fs.existsSync(path.join(run.runDir, 'summary.json'))).toBe(true);
      expect(fs.existsSync(path.join(run.runDir, 'split-held-in.json'))).toBe(true);
    },
    30000,
  );

  it(
    'cleans up every isolated task workspace',
    async () => {
      const be = backend();
      const split = loadSplit(HELD_IN);
      const run = await be.evaluate(null, split, { runId: 'cleanup-1' });
      expect(run.status).toBe('ok');

      // No leftover kc-eval-task-* dirs under the dedicated parent.
      const leftovers = fs
        .readdirSync(workDirParent)
        .filter((name) => name.startsWith('kc-eval-task-'));
      expect(leftovers).toEqual([]);
    },
    30000,
  );

  it(
    'run-level budget cap → blocked with partial results',
    async () => {
      const be = backend();
      const split = loadSplit(HELD_IN);
      // held-in mock costs sum to 0.01+0.02+0.005 = 0.035; cap below that.
      const run = await be.evaluate(null, split, {
        runId: 'budget-block',
        maxBudgetUsd: 0.01,
      });
      expect(run.status).toBe('blocked');
      if (run.status !== 'blocked') return;
      expect(run.reason).toMatch(/budget exceeded/i);
      // At least one task ran before the cap tripped.
      expect(run.partial.length).toBeGreaterThanOrEqual(1);
    },
    30000,
  );

  it(
    'run-level timeout cap → blocked',
    async () => {
      const be = backend();
      const split = loadSplit(HELD_IN);
      const run = await be.evaluate(null, split, {
        runId: 'timeout-block',
        // 0s is ignored (non-positive); use a tiny positive that trips on the
        // second iteration check. First task starts after startedAt so a 1ms
        // cap still lets the first task run, then blocks.
        timeoutSec: 0.001,
      });
      expect(run.status).toBe('blocked');
      if (run.status !== 'blocked') return;
      expect(run.reason).toMatch(/timeout exceeded/i);
    },
    30000,
  );

  it(
    'per-task budget exceeded is recorded as errorCode without blocking the run',
    async () => {
      const be = backend();
      const set: EvalSet = JSON.parse(JSON.stringify(loadEvalSet(HELD_IN)));
      const task = set.tasks.find((t) => t.taskId === 'hi-write-greeting')!;
      task.mock = {
        mode: 'apply-patch',
        turns: 2,
        costUsd: 99, // way over maxBudgetUsd 0.1
        patchFiles: task.mock?.patchFiles,
      };
      const split: EvalSplit = { name: 'held-in', set };

      const run = await be.evaluate(null, split, { runId: 'task-budget' });
      expect(run.status).toBe('ok');
      if (run.status !== 'ok') return;
      const rec = run.tasks.find((t) => t.taskId === 'hi-write-greeting')!;
      expect(rec.errorCode).toBe('budget_exceeded');
      expect(rec.success).toBe(false);
      // siblings still ran
      expect(run.tasks).toHaveLength(set.tasks.length);
    },
    30000,
  );

  it(
    'single missing fixture does not pollute sibling tasks',
    async () => {
      const be = backend();
      const set: EvalSet = JSON.parse(JSON.stringify(loadEvalSet(HELD_IN)));
      const bad = set.tasks.find((t) => t.taskId === 'hi-fix-typo')!;
      bad.repo = 'local:scripts/eval/fixtures/does-not-exist-xyz';
      const split: EvalSplit = { name: 'held-in', set };

      const run = await be.evaluate(null, split, { runId: 'iso-fail' });
      expect(run.status).toBe('ok');
      if (run.status !== 'ok') return;

      const failed = run.tasks.find((t) => t.taskId === 'hi-fix-typo')!;
      expect(failed.errorCode).toBe('eval_error');
      expect(failed.success).toBe(false);

      const ok = run.tasks.find((t) => t.taskId === 'hi-write-greeting')!;
      expect(ok.verified).toBe(true);
      expect(ok.errorCode).toBeNull();
    },
    30000,
  );

  it(
    'variant pin is recorded in meta and mock payload overrides only the pin arm',
    async () => {
      const be = backend();
      const set = loadEvalSet(HELD_IN);
      const split: EvalSplit = { name: 'held-in', set };

      // Candidate claims a different greeting content — isolated workdir only.
      const payload: MockVariantPayload = {
        mockTaskOverrides: {
          'hi-write-greeting': {
            patchFiles: [{ path: 'greeting.txt', content: 'Hello from candidate\n' }],
            turns: 2,
            costUsd: 0.01,
          },
        },
      };
      const pin: VariantPin = { ...CANDIDATE, payload };

      const base = await be.evaluate(null, split, { runId: 'pin-base' });
      const cand = await be.evaluate(pin, split, { runId: 'pin-cand' });
      expect(base.status).toBe('ok');
      expect(cand.status).toBe('ok');
      if (base.status !== 'ok' || cand.status !== 'ok') return;

      // Source fixture untouched.
      const sourceGreeting = path.join(
        REPO_ROOT,
        'scripts/eval/fixtures/write-greeting/greeting.txt',
      );
      // fixture may or may not ship greeting.txt; if it does it must still be baseline content
      if (fs.existsSync(sourceGreeting)) {
        expect(fs.readFileSync(sourceGreeting, 'utf8')).not.toContain(
          'Hello from candidate',
        );
      }

      // Eval set file untouched.
      expect(fs.readFileSync(HELD_IN, 'utf8')).not.toContain('Hello from candidate');

      const meta = JSON.parse(fs.readFileSync(path.join(cand.runDir, 'meta.json'), 'utf8'));
      expect(meta.pin.variantId).toBe('cand-001');
      expect(meta.variantEnv.KC_EXPERIMENTS_ENABLED).toBe('1');
      expect(meta.variantEnv.KC_EXPERIMENT_VARIANT_OVERRIDE).toContain('cand-001');

      const baseMeta = JSON.parse(
        fs.readFileSync(path.join(base.runDir, 'meta.json'), 'utf8'),
      );
      expect(baseMeta.pin).toBeNull();
      expect(baseMeta.variantEnv.KC_EXPERIMENTS_ENABLED).toBe('0');
    },
    30000,
  );

  it(
    'does not mutate process.env',
    async () => {
      const before = {
        enabled: process.env.KC_EXPERIMENTS_ENABLED,
        override: process.env.KC_EXPERIMENT_VARIANT_OVERRIDE,
      };
      const be = backend();
      const split = loadSplit(HELD_IN);
      await be.evaluate(CANDIDATE, split, { runId: 'env-safe' });
      expect(process.env.KC_EXPERIMENTS_ENABLED).toBe(before.enabled);
      expect(process.env.KC_EXPERIMENT_VARIANT_OVERRIDE).toBe(before.override);
    },
    30000,
  );

  it(
    'evaluatePair runs baseline and candidate arms on the same split',
    async () => {
      const be = backend();
      const split = loadSplit(HELD_OUT);
      const { baseline, candidate } = await evaluatePair(be, CANDIDATE, split, {
        runId: 'pair-held-out',
      });
      expect(baseline.status).toBe('ok');
      expect(candidate.status).toBe('ok');
      if (baseline.status !== 'ok' || candidate.status !== 'ok') return;
      // Distinct run dirs — artifacts must not overwrite.
      expect(baseline.runDir).not.toBe(candidate.runDir);
      expect(path.basename(baseline.runDir)).toBe('pair-held-out-baseline');
      expect(path.basename(candidate.runDir)).toBe('pair-held-out-candidate');
      // Deterministic mock without payload overrides → identical splits.
      expect(baseline.split).toEqual(candidate.split);
      expect(baseline.split.verifiedTaskRate).toBe(1);
    },
    30000,
  );
});

describe('agp-lab/swebench-backend', () => {
  it('returns blocked when evaluation/swe_bench/adapter is missing', async () => {
    // As of T5 the adapter does not exist in-repo.
    expect(findSwebenchAdapter()).toBeNull();

    const be = createSwebenchBackend();
    expect(be.name).toBe('swebench');
    const split = loadSplit(HELD_IN);
    const run = await be.evaluate(null, split);
    expect(run.status).toBe('blocked');
    if (run.status !== 'blocked') return;
    expect(run.reason).toMatch(/adapter\.ts not found|not implemented/i);
    expect(run.partial).toEqual([]);
  });
});
