import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildCanaryReport,
  suggestRollback,
  toSplitResult,
} from '../../scripts/agp/report';
import type { RunOutcome } from '../../src/experiments/protocol';

function writeOutcomes(dir: string, file: string, outcomes: RunOutcome[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, file),
    outcomes.map(o => JSON.stringify(o)).join('\n') + '\n',
    'utf8'
  );
}

function outcome(over: Partial<RunOutcome> = {}): RunOutcome {
  return {
    runId: 'r1',
    sessionId: 's1',
    artifactAssignments: [],
    success: true,
    verified: true,
    patchFiles: ['a.ts'],
    turns: 2,
    noPatch: false,
    costUsd: 0.01,
    timestamp: 1,
    ...over,
  };
}

describe('agp-lab/report', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-report-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns empty report for missing runs dir', () => {
    const report = buildCanaryReport(path.join(tmp, 'nope'));
    expect(report.totalOutcomes).toBe(0);
    expect(report.byVariant).toEqual([]);
  });

  it('aggregates by variant and separates baseline-like outcomes', () => {
    writeOutcomes(tmp, 'a.jsonl', [
      outcome({
        artifactAssignments: [
          {
            artifactId: 'prompt-surface:failure-recovery',
            variantId: 'c1',
            baseHash: 'sha256:b',
            evidenceRef: 'sha256:e',
          },
        ],
        success: true,
        verified: true,
        noPatch: false,
        turns: 2,
        costUsd: 0.01,
      }),
      outcome({
        runId: 'r2',
        artifactAssignments: [
          {
            artifactId: 'prompt-surface:failure-recovery',
            variantId: 'c1',
            baseHash: 'sha256:b',
            evidenceRef: 'sha256:e',
          },
        ],
        success: false,
        verified: false,
        noPatch: true,
        turns: 4,
        costUsd: 0.03,
        errorCode: 'query_error',
      }),
      outcome({ runId: 'r3', artifactAssignments: [], verified: true }),
    ]);

    const report = buildCanaryReport(tmp);
    expect(report.totalOutcomes).toBe(3);
    expect(report.byVariant).toHaveLength(1);
    const m = report.byVariant[0];
    expect(m.variantId).toBe('c1');
    expect(m.runs).toBe(2);
    expect(m.successRate).toBeCloseTo(0.5);
    expect(m.verifiedRate).toBeCloseTo(0.5);
    expect(m.noPatchRate).toBeCloseTo(0.5);
    expect(m.errorCodes.query_error).toBe(1);
    expect(report.baselineLike).toHaveLength(1);
    expect(report.baselineLike[0].variantId).toBe('baseline');
  });

  it('suggestRollback fires when verified rate drops past threshold', () => {
    const report = buildCanaryReport(tmp);
    const withVariant = {
      ...report,
      byVariant: [
        {
          artifactId: 'prompt-surface:failure-recovery',
          variantId: 'c1',
          runs: 4,
          successRate: 0.25,
          verifiedRate: 0.25,
          noPatchRate: 0.5,
          avgTurns: 3,
          avgCostUsd: 0.02,
          errorCodes: {},
        },
      ],
    };
    const suggestions = suggestRollback(withVariant, 0.5, 0.1);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].variantId).toBe('c1');
    expect(suggestions[0].reason).toContain('below baseline');
  });

  it('toSplitResult maps metrics for gate comparison', () => {
    const split = toSplitResult({
      artifactId: 'x',
      variantId: 'y',
      runs: 3,
      successRate: 1,
      verifiedRate: 0.8,
      noPatchRate: 0.1,
      avgTurns: 2,
      avgCostUsd: 0.01,
      errorCodes: {},
    });
    expect(split.verifiedTaskRate).toBe(0.8);
    expect(split.tasks).toBe(3);
    expect(split.safetyViolations).toBe(0);
  });

  it('skips corrupt JSONL lines without throwing', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'mixed.jsonl'),
      JSON.stringify(outcome()) + '\n{not json\n' + JSON.stringify(outcome({ runId: 'r2' })) + '\n',
      'utf8'
    );
    const report = buildCanaryReport(tmp);
    expect(report.totalOutcomes).toBe(2);
  });
});
