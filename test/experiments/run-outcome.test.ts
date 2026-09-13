import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FileExperimentRuntime } from '../../src/experiments/runtime';
import type { RunOutcome } from '../../src/experiments/protocol';
import { buildCanaryReport, suggestRollback, toSplitResult } from '../../scripts/agp/report';
import { createNoopExperimentRuntime } from '../../src/experiments/protocol';

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: 'r1',
    sessionId: 's1',
    taskId: 't1',
    artifactAssignments: [],
    success: true,
    verified: false,
    patchFiles: [],
    turns: 1,
    noPatch: true,
    timestamp: 1,
    ...over,
  };
}

describe('experiments/run-outcome + canary report', () => {
  let tmp: string;
  let runsDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-run-out-'));
    runsDir = path.join(tmp, 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('noop runtime does not write outcomes', async () => {
    const rt = createNoopExperimentRuntime();
    await rt.recordRunOutcome(outcome());
    expect(fs.readdirSync(runsDir)).toEqual([]);
  });

  it('writes JSONL outcomes on success, failure, and budget stop', async () => {
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 'sess-abc',
      runsDir,
    });
    rt.initialize();
    await rt.recordRunOutcome(outcome({ success: true, verified: true, patchFiles: ['a.ts'], noPatch: false }));
    await rt.recordRunOutcome(outcome({ success: false, errorCode: 'query_error', noPatch: true }));
    await rt.recordRunOutcome(outcome({ success: false, errorCode: 'budget_exceeded', turns: 50 }));
    const file = path.join(runsDir, 'sess-abc.jsonl');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    const parsed = lines.map(l => JSON.parse(l) as RunOutcome);
    expect(parsed.some(o => o.errorCode === 'budget_exceeded')).toBe(true);
    expect(parsed.some(o => o.verified)).toBe(true);
  });

  it('write failure does not throw', async () => {
    // Point runsDir at a file path so mkdir/append fails.
    const bad = path.join(tmp, 'not-a-dir');
    fs.writeFileSync(bad, 'x', 'utf8');
    const rt = new FileExperimentRuntime({
      enabled: true,
      cwd: tmp,
      sessionId: 's',
      runsDir: bad,
    });
    rt.initialize();
    await expect(rt.recordRunOutcome(outcome())).resolves.toBeUndefined();
  });

  it('aggregates canary metrics by variant', async () => {
    const assignments = [
      {
        artifactId: 'prompt-surface:failure-recovery',
        variantId: 'c1',
        baseHash: 'sha256:b',
        evidenceRef: 'sha256:e',
      },
    ];
    fs.writeFileSync(
      path.join(runsDir, 's1.jsonl'),
      [
        JSON.stringify(outcome({ success: true, verified: true, noPatch: false, turns: 2, costUsd: 0.01, artifactAssignments: assignments })),
        JSON.stringify(outcome({ success: true, verified: true, noPatch: false, turns: 3, costUsd: 0.02, artifactAssignments: assignments })),
        JSON.stringify(outcome({ success: false, verified: false, noPatch: true, turns: 1, costUsd: 0.01, errorCode: 'query_error', artifactAssignments: assignments })),
        JSON.stringify(outcome({ success: true, verified: true, noPatch: false, turns: 2, costUsd: 0.01 })),
      ].join('\n'),
      'utf8'
    );
    const report = buildCanaryReport(runsDir);
    expect(report.totalOutcomes).toBe(4);
    expect(report.byVariant).toHaveLength(1);
    expect(report.byVariant[0].runs).toBe(3);
    expect(report.byVariant[0].verifiedRate).toBeCloseTo(2 / 3);
    expect(report.byVariant[0].noPatchRate).toBeCloseTo(1 / 3);
    expect(report.baselineLike).toHaveLength(1);
    expect(report.baselineLike[0].runs).toBe(1);
  });

  it('suggestRollback flags verified-rate drop beyond threshold', () => {
    const report = buildCanaryReport(runsDir); // empty
    report.byVariant.push({
      artifactId: 'prompt-surface:failure-recovery',
      variantId: 'bad',
      runs: 10,
      successRate: 0.2,
      verifiedRate: 0.5,
      noPatchRate: 0.5,
      avgTurns: 2,
      avgCostUsd: 0.01,
      errorCodes: {},
    });
    const suggestions = suggestRollback(report, 0.7, 0.1);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].variantId).toBe('bad');
  });

  it('toSplitResult maps metrics for gate comparison', () => {
    const m = {
      artifactId: 'x',
      variantId: 'y',
      runs: 3,
      successRate: 1,
      verifiedRate: 0.8,
      noPatchRate: 0.1,
      avgTurns: 2.5,
      avgCostUsd: 0.02,
      errorCodes: {},
    };
    const split = toSplitResult(m);
    expect(split.verifiedTaskRate).toBe(0.8);
    expect(split.tasks).toBe(3);
  });
});
