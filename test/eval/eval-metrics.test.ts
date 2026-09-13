// AGP T1 — SplitResult 聚合边界 + mock 重复运行同结果
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  TASK_RESULT_FORMAT,
  aggregateSplitResult,
  emptySplitResult,
  loadTaskRecords,
  summarizeRun,
  truncateStdout,
  STDOUT_MAX,
  type TaskResult,
} from '../../scripts/eval/metrics';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const HARNESS = path.join(REPO_ROOT, 'scripts/eval/agent-longtask-harness.mjs');

function mkRecord(over: Partial<TaskResult> & { taskId: string }): TaskResult {
  return {
    format: TASK_RESULT_FORMAT,
    split: 'held-in',
    backend: 'mock',
    runId: 'r',
    repo: 'local:x',
    commit: 'c',
    success: true,
    verified: true,
    noPatch: false,
    turns: 2,
    costUsd: 0.01,
    patchFiles: ['a.txt'],
    verificationCommand: 'node verify.mjs',
    verificationExitCode: 0,
    safetyViolations: 0,
    errorCode: null,
    stdoutExcerpt: 'ok',
    timestamp: 0,
    ...over,
  };
}

describe('eval metrics aggregation', () => {
  it('empty records → zero SplitResult', () => {
    expect(aggregateSplitResult([])).toEqual(emptySplitResult());
  });

  it('all verified, no no-patch', () => {
    const r = aggregateSplitResult([mkRecord({ taskId: 'a' }), mkRecord({ taskId: 'b' })]);
    expect(r.tasks).toBe(2);
    expect(r.verifiedTaskRate).toBe(1);
    expect(r.noPatchRate).toBe(0);
    expect(r.avgTurns).toBe(2);
    expect(r.avgCostUsd).toBeCloseTo(0.01, 6);
    expect(r.safetyViolations).toBe(0);
  });

  it('mixed verified / no-patch rates', () => {
    const r = aggregateSplitResult([
      mkRecord({ taskId: 'a', verified: true, noPatch: false }),
      mkRecord({ taskId: 'b', verified: false, noPatch: true, patchFiles: [], verificationExitCode: null }),
      mkRecord({ taskId: 'c', verified: false, noPatch: false }),
      mkRecord({ taskId: 'd', verified: true, noPatch: false }),
    ]);
    expect(r.tasks).toBe(4);
    expect(r.verifiedTaskRate).toBe(0.5);
    expect(r.noPatchRate).toBe(0.25);
  });

  it('sums safetyViolations and averages turns/cost', () => {
    const r = aggregateSplitResult([
      mkRecord({ taskId: 'a', turns: 1, costUsd: 0.1, safetyViolations: 1 }),
      mkRecord({ taskId: 'b', turns: 3, costUsd: 0.3, safetyViolations: 2 }),
    ]);
    expect(r.avgTurns).toBe(2);
    expect(r.avgCostUsd).toBeCloseTo(0.2, 6);
    expect(r.safetyViolations).toBe(3);
  });

  it('truncateStdout caps at 4KB', () => {
    const long = 'x'.repeat(STDOUT_MAX + 100);
    expect(truncateStdout(long).length).toBe(STDOUT_MAX);
    expect(truncateStdout('short')).toBe('short');
  });
});

describe('eval run directory loading', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-eval-metrics-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('loadTaskRecords + summarizeRun from on-disk layout', () => {
    const runDir = path.join(tmp, 'manual-run');
    fs.mkdirSync(path.join(runDir, 'tasks', 't1'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'tasks', 't2'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'meta.json'),
      JSON.stringify({ runId: 'manual-run', backend: 'mock', createdAt: '2026-01-01T00:00:00.000Z' }),
    );
    fs.writeFileSync(
      path.join(runDir, 'tasks', 't1', 'record.json'),
      JSON.stringify(mkRecord({ taskId: 't1', split: 'held-in' })),
    );
    fs.writeFileSync(
      path.join(runDir, 'tasks', 't2', 'record.json'),
      JSON.stringify(
        mkRecord({ taskId: 't2', split: 'held-out', verified: false, noPatch: true, patchFiles: [] }),
      ),
    );

    const heldIn = loadTaskRecords(runDir, 'held-in');
    expect(heldIn).toHaveLength(1);
    expect(heldIn[0]!.taskId).toBe('t1');

    const summary = summarizeRun(runDir);
    expect(summary.runId).toBe('manual-run');
    expect(summary.splits['held-in']?.tasks).toBe(1);
    expect(summary.splits['held-out']?.noPatchRate).toBe(1);
  });
});

describe('mock backend determinism (harness run-baseline)', () => {
  let runsRoot: string;

  beforeAll(() => {
    runsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-eval-runs-'));
  });

  afterAll(() => {
    fs.rmSync(runsRoot, { recursive: true, force: true });
  });

  function runBaseline(runId: string) {
    const res = spawnSync(
      process.execPath,
      [HARNESS, 'run-baseline', '--backend', 'mock', '--run', runId, '--runs-root', runsRoot],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 20000 },
    );
    if (res.status !== 0) {
      throw new Error(`run-baseline failed: ${res.stderr || res.stdout}`);
    }
    return path.join(runsRoot, runId);
  }

  it(
    'two mock baseline runs produce identical SplitResult',
    () => {
      const dirA = runBaseline('mock-a');
      const dirB = runBaseline('mock-b');
      const sumA = JSON.parse(fs.readFileSync(path.join(dirA, 'summary.json'), 'utf8'));
      const sumB = JSON.parse(fs.readFileSync(path.join(dirB, 'summary.json'), 'utf8'));
      expect(sumA.splits).toEqual(sumB.splits);
      expect(sumA.splits['held-in'].tasks).toBeGreaterThanOrEqual(2);
      expect(sumA.splits['held-out'].tasks).toBeGreaterThanOrEqual(2);
      expect(sumA.splits['held-in'].safetyViolations).toBe(0);
      expect(sumA.splits['held-out'].safetyViolations).toBe(0);
      // held-in 含 no-patch 任务 → rate > 0；held-out 全 verified
      expect(sumA.splits['held-in'].noPatchRate).toBeGreaterThan(0);
      expect(sumA.splits['held-out'].verifiedTaskRate).toBe(1);
    },
    60000,
  );

  it(
    'persists patch, verification exit code, turns, cost, no-patch flag',
    () => {
      const dirA = runBaseline('mock-detail');
      const recordPath = path.join(dirA, 'tasks', 'hi-write-greeting', 'record.json');
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
      expect(record.verified).toBe(true);
      expect(record.noPatch).toBe(false);
      expect(record.patchFiles).toContain('greeting.txt');
      expect(record.verificationExitCode).toBe(0);
      expect(record.turns).toBeGreaterThan(0);
      expect(record.costUsd).toBeGreaterThan(0);
      expect(record.stdoutExcerpt.length).toBeLessThanOrEqual(STDOUT_MAX);

      const noPatchRec = JSON.parse(
        fs.readFileSync(path.join(dirA, 'tasks', 'hi-no-patch-observe', 'record.json'), 'utf8'),
      );
      expect(noPatchRec.noPatch).toBe(true);
      expect(noPatchRec.verified).toBe(false);
      expect(noPatchRec.patchFiles).toEqual([]);

      expect(fs.existsSync(path.join(dirA, 'tasks', 'hi-write-greeting', 'patch.diff'))).toBe(true);
    },
    60000,
  );
});
