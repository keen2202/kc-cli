// Tests for T7 (M2): task-completion acceptance report.
//
// Covers the pure report builder, the markdown formatter, and best-effort disk
// persistence. The builder is intentionally decoupled from QueryEngine so these
// run without a live engine / LLM.
//
// - buildAcceptanceReport aggregates modified files, backups, gates, ops, tokens
// - backups are de-duplicated and only journal entries with a backupPath count
// - operation counts + error totals come from audit-entry shapes
// - honest gate reporting: skipped/not-run gates render as "not run"
// - empty task (zero modifications) still yields a sensible report
// - markdown contains the expected sections and gate statuses
// - writeAcceptanceReport persists under .kc-cli/reports/ and sanitizes session

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  buildAcceptanceReport,
  formatAcceptanceReportMarkdown,
  writeAcceptanceReport,
  skippedGate,
  type AcceptanceReportInput,
  type VerificationGateReport,
} from '../../src/query/completion-report';

const passGate: VerificationGateReport = { ran: true, command: 'npx tsc --noEmit', result: 'pass' };
const failGate: VerificationGateReport = {
  ran: true,
  command: 'npx tsc --noEmit',
  result: 'fail',
  details: 'src/x.ts(1,1): error TS1005',
};

function makeInput(overrides: Partial<AcceptanceReportInput> = {}): AcceptanceReportInput {
  return {
    sessionId: 'sess-1',
    turnCount: 3,
    modifiedFiles: ['/repo/src/a.ts', '/repo/src/b.ts'],
    journalEntries: [
      { filePath: '/repo/src/a.ts', backupPath: '/repo/.kc-cli/backups/a.ts.1.bak' },
      { filePath: '/repo/src/b.ts', backupPath: null },
    ],
    typeCheck: passGate,
    tests: skippedGate(),
    auditEntries: [
      { tool: 'FileWrite', isError: false },
      { tool: 'FileWrite', isError: false },
      { tool: 'Bash', isError: true },
    ],
    tokens: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    ...overrides,
  };
}

describe('buildAcceptanceReport', () => {
  it('aggregates modified files, backups, ops and tokens', () => {
    const report = buildAcceptanceReport(makeInput());

    expect(report.sessionId).toBe('sess-1');
    expect(report.turnCount).toBe(3);
    expect(report.modifiedFiles).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    // Only the entry with a real backupPath becomes a rollback ref.
    expect(report.backups).toEqual([
      { filePath: '/repo/src/a.ts', backupPath: '/repo/.kc-cli/backups/a.ts.1.bak' },
    ]);
    expect(report.operationCounts).toEqual({ FileWrite: 2, Bash: 1 });
    expect(report.operationErrors).toBe(1);
    expect(report.tokens.totalTokens).toBe(150);
    expect(report.typeCheck.result).toBe('pass');
    expect(report.tests.result).toBe('skipped');
  });

  it('de-duplicates repeated backup paths', () => {
    const report = buildAcceptanceReport(
      makeInput({
        journalEntries: [
          { filePath: '/repo/a.ts', backupPath: '/b/a.bak' },
          { filePath: '/repo/a.ts', backupPath: '/b/a.bak' },
          { filePath: '/repo/a.ts', backupPath: '/b/a2.bak' },
        ],
      }),
    );
    expect(report.backups).toHaveLength(2);
  });

  it('copies modifiedFiles so later mutation does not leak in', () => {
    const src = ['/repo/x.ts'];
    const report = buildAcceptanceReport(makeInput({ modifiedFiles: src }));
    src.push('/repo/y.ts');
    expect(report.modifiedFiles).toEqual(['/repo/x.ts']);
  });

  it('produces a sensible report for an empty (zero-change) task', () => {
    const report = buildAcceptanceReport(
      makeInput({
        modifiedFiles: [],
        journalEntries: [],
        auditEntries: [],
        typeCheck: skippedGate(),
        tests: skippedGate(),
      }),
    );
    expect(report.modifiedFiles).toEqual([]);
    expect(report.backups).toEqual([]);
    expect(report.operationCounts).toEqual({});
    expect(report.operationErrors).toBe(0);
    expect(report.typeCheck.ran).toBe(false);
  });

  it('defaults ts to now when not supplied', () => {
    const before = Date.now();
    const report = buildAcceptanceReport(makeInput());
    expect(report.ts).toBeGreaterThanOrEqual(before);
  });
});

describe('formatAcceptanceReportMarkdown', () => {
  it('renders sections, gate statuses and change lists', () => {
    const md = formatAcceptanceReportMarkdown(buildAcceptanceReport(makeInput()));

    expect(md).toContain('# Task Completion Report');
    expect(md).toContain('## Verification');
    expect(md).toContain('## Changes');
    expect(md).toContain('## Rollback Evidence');
    expect(md).toContain('## Operations');
    // Passing type-check and skipped tests are both surfaced honestly.
    expect(md).toContain('Type-check:** ✅ pass');
    expect(md).toContain('Tests:** ⏭️ not run');
    expect(md).toContain('`/repo/src/a.ts`');
    expect(md).toContain('**FileWrite:** 2');
  });

  it('shows failure details for a failed gate', () => {
    const md = formatAcceptanceReportMarkdown(
      buildAcceptanceReport(makeInput({ typeCheck: failGate })),
    );
    expect(md).toContain('Type-check:** ❌ fail');
    expect(md).toContain('error TS1005');
  });

  it('states no changes / no backups / no operations when empty', () => {
    const md = formatAcceptanceReportMarkdown(
      buildAcceptanceReport(
        makeInput({ modifiedFiles: [], journalEntries: [], auditEntries: [] }),
      ),
    );
    expect(md).toContain('No files modified.');
    expect(md).toContain('No backup snapshots produced.');
    expect(md).toContain('No audited operations.');
  });
});

describe('writeAcceptanceReport', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'accept-report-test-'));
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes a markdown report under .kc-cli/reports/ and returns its path', async () => {
    const report = buildAcceptanceReport(makeInput({ ts: 1721800000000 }));
    const file = await writeAcceptanceReport(report, tmpDir);

    expect(file).toBeTruthy();
    expect(file!).toContain(path.join('.kc-cli', 'reports'));
    expect(fs.existsSync(file!)).toBe(true);
    const content = await fs.promises.readFile(file!, 'utf-8');
    expect(content).toContain('# Task Completion Report');
  });

  it('sanitizes unsafe characters in the session id for the filename', async () => {
    const report = buildAcceptanceReport(makeInput({ sessionId: 'a/b:c*d', ts: 1721800000000 }));
    const file = await writeAcceptanceReport(report, tmpDir);
    expect(file).toBeTruthy();
    expect(path.basename(file!)).toBe('a_b_c_d-1721800000000.md');
  });

  it('returns null on write failure instead of throwing', async () => {
    // Point cwd at a file so mkdir(.kc-cli/reports) cannot succeed.
    const blocker = path.join(tmpDir, 'not-a-dir');
    await fs.promises.writeFile(blocker, 'x', 'utf-8');
    const report = buildAcceptanceReport(makeInput());
    await expect(writeAcceptanceReport(report, blocker)).resolves.toBeNull();
  });
});
