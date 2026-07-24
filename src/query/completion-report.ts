/**
 * T7 (M2): task-completion acceptance report.
 *
 * At task completion the QueryEngine assembles a structured, evidence-based
 * acceptance report from signals it already tracks — modified files, T2 backup
 * snapshots (via the T3 journal), the pre-exit type-check / test gate outcomes,
 * T6 operation-audit entries, turn count and token usage. No extra LLM call is
 * made: the report is pure aggregation of existing state.
 *
 * The report is attached to the `agent:complete` event and can optionally be
 * persisted to `.kc-cli/reports/<session>-<ts>.md` for user / CI acceptance.
 *
 * Honesty guarantee: verification gates that never ran (type-check disabled, no
 * FAIL_TO_PASS tests, etc.) are reported as `ran:false` / `result:'skipped'`
 * rather than being silently presented as "verified".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TokenUsage } from '../state/events';

/** Outcome of a single pre-exit verification gate (type-check or tests). */
export interface VerificationGateReport {
  /** Whether the gate produced a definitive pass/fail/timeout determination. */
  ran: boolean;
  /** The command that was (or would have been) executed, when known. */
  command: string | null;
  /** Normalized gate result. `skipped` means the gate was never invoked. */
  result: 'pass' | 'fail' | 'timeout' | 'infra_error' | 'not_found' | 'skipped';
  /** Optional captured failure/diagnostic detail (truncated by the caller). */
  details?: string;
}

/** A backup snapshot produced during the task (T2 `.bak`, recorded in T3 journal). */
export interface BackupRef {
  filePath: string;
  backupPath: string;
}

/** Structured task-completion acceptance report. */
export interface AcceptanceReport {
  sessionId: string;
  /** Report generation timestamp (ms epoch). */
  ts: number;
  /** Total agent turns consumed. */
  turnCount: number;
  /** Absolute paths of files modified during the task. */
  modifiedFiles: string[];
  /** Backup snapshots captured before overwrites (rollback evidence). */
  backups: BackupRef[];
  /** Pre-exit type-check gate outcome. */
  typeCheck: VerificationGateReport;
  /** Pre-exit test gate outcome. */
  tests: VerificationGateReport;
  /** Count of audited high-risk operations by tool name. */
  operationCounts: Record<string, number>;
  /** Number of audited operations that reported an error. */
  operationErrors: number;
  /** Token usage for the session. */
  tokens: TokenUsage;
}

/** Minimal shapes consumed by {@link buildAcceptanceReport} (kept decoupled). */
export interface AcceptanceReportInput {
  sessionId: string;
  turnCount: number;
  modifiedFiles: string[];
  journalEntries: readonly { filePath: string; backupPath: string | null }[];
  typeCheck: VerificationGateReport;
  tests: VerificationGateReport;
  auditEntries: readonly { tool: string; isError: boolean }[];
  tokens: TokenUsage;
  ts?: number;
}

/** A gate that was never invoked. */
export function skippedGate(): VerificationGateReport {
  return { ran: false, command: null, result: 'skipped' };
}

/**
 * Assemble an {@link AcceptanceReport} from already-tracked signals. Pure: no
 * I/O, no LLM calls — safe to unit-test in isolation.
 */
export function buildAcceptanceReport(input: AcceptanceReportInput): AcceptanceReport {
  const backups: BackupRef[] = [];
  const seen = new Set<string>();
  for (const e of input.journalEntries) {
    if (e.backupPath && !seen.has(e.backupPath)) {
      seen.add(e.backupPath);
      backups.push({ filePath: e.filePath, backupPath: e.backupPath });
    }
  }

  const operationCounts: Record<string, number> = {};
  let operationErrors = 0;
  for (const a of input.auditEntries) {
    operationCounts[a.tool] = (operationCounts[a.tool] ?? 0) + 1;
    if (a.isError) operationErrors++;
  }

  return {
    sessionId: input.sessionId,
    ts: input.ts ?? Date.now(),
    turnCount: input.turnCount,
    modifiedFiles: [...input.modifiedFiles],
    backups,
    typeCheck: input.typeCheck,
    tests: input.tests,
    operationCounts,
    operationErrors,
    tokens: input.tokens,
  };
}

/** Render a verification gate as a short human-readable status string. */
function gateLine(label: string, gate: VerificationGateReport): string {
  const status = !gate.ran
    ? gate.result === 'skipped'
      ? '⏭️ not run'
      : `⚠️ ${gate.result} (not run)`
    : gate.result === 'pass'
      ? '✅ pass'
      : `❌ ${gate.result}`;
  const cmd = gate.command ? ` — \`${gate.command}\`` : '';
  return `- **${label}:** ${status}${cmd}`;
}

/** Render an {@link AcceptanceReport} as Markdown for disk / display. */
export function formatAcceptanceReportMarkdown(report: AcceptanceReport): string {
  const lines: string[] = [];
  lines.push(`# Task Completion Report`);
  lines.push('');
  lines.push(`- **Session:** ${report.sessionId}`);
  lines.push(`- **Generated:** ${new Date(report.ts).toISOString()}`);
  lines.push(`- **Turns:** ${report.turnCount}`);
  lines.push(
    `- **Tokens:** ${report.tokens.totalTokens} total ` +
      `(in ${report.tokens.inputTokens} / out ${report.tokens.outputTokens})`,
  );
  lines.push('');

  lines.push(`## Verification`);
  lines.push(gateLine('Type-check', report.typeCheck));
  lines.push(gateLine('Tests', report.tests));
  if (report.typeCheck.details) {
    lines.push('');
    lines.push('<details><summary>Type-check output</summary>');
    lines.push('');
    lines.push('```');
    lines.push(report.typeCheck.details);
    lines.push('```');
    lines.push('</details>');
  }
  lines.push('');

  lines.push(`## Changes`);
  if (report.modifiedFiles.length === 0) {
    lines.push('- No files modified.');
  } else {
    lines.push(`Modified ${report.modifiedFiles.length} file(s):`);
    for (const f of report.modifiedFiles) lines.push(`- \`${f}\``);
  }
  lines.push('');

  lines.push(`## Rollback Evidence`);
  if (report.backups.length === 0) {
    lines.push('- No backup snapshots produced.');
  } else {
    lines.push(`${report.backups.length} backup snapshot(s):`);
    for (const b of report.backups) lines.push(`- \`${b.filePath}\` → \`${b.backupPath}\``);
  }
  lines.push('');

  lines.push(`## Operations`);
  const toolNames = Object.keys(report.operationCounts).sort();
  if (toolNames.length === 0) {
    lines.push('- No audited operations.');
  } else {
    for (const t of toolNames) lines.push(`- **${t}:** ${report.operationCounts[t]}`);
    lines.push(`- **Errors:** ${report.operationErrors}`);
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Persist a report to `.kc-cli/reports/<session>-<ts>.md`. Best-effort: any
 * failure resolves to `null` so report writing never disrupts completion.
 * Returns the written file path on success.
 */
export async function writeAcceptanceReport(
  report: AcceptanceReport,
  cwd: string,
): Promise<string | null> {
  try {
    const dir = path.join(cwd, '.kc-cli', 'reports');
    await fs.promises.mkdir(dir, { recursive: true });
    const safeSession = report.sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
    const file = path.join(dir, `${safeSession}-${report.ts}.md`);
    await fs.promises.writeFile(file, formatAcceptanceReportMarkdown(report), 'utf-8');
    return file;
  } catch {
    return null;
  }
}
