// Tests for T4 (H4): non-Git workspace rollback safety-net detection + warnings.
//
// Verifies:
//   - isInsideGitRepo distinguishes a real repo from a plain directory
//   - autoStageFile / autoCommitAll surface the FIRST failure via logger.warn
//     (debounced) instead of swallowing it silently
//   - the warn is debounced to exactly one entry per process run

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import {
  isInsideGitRepo,
  autoStageFile,
  autoCommitAll,
  resetGitWarnDebounce,
} from '../../src/utils/git';
import { configureLogger, type LogEntry } from '../../src/services/logger';

/** Initialize a real Git repo in `dir` (skips the test if git is unavailable). */
function gitInit(dir: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['init'], { cwd: dir, stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

describe('Git rollback safety net (T4)', () => {
  let tmpDir: string;
  let warnEntries: LogEntry[];

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'git-safety-net-'));
    resetGitWarnDebounce();
    warnEntries = [];
    // Capture structured log entries via a formatter side-channel; the output
    // sink is a no-op so nothing hits the console during the test run.
    configureLogger({
      minLevel: 'debug',
      formatter: (entry) => {
        if (entry.level === 'warn' && entry.module === 'git') warnEntries.push(entry);
        return '';
      },
      output: () => {},
    });
  });

  afterEach(async () => {
    // Install a no-op capturing formatter so any late warn from a fire-and-forget
    // `autoStageFile` git spawn that closes during teardown is NOT captured into a
    // sibling test's `warnEntries` (cross-test isolation for async best-effort ops).
    configureLogger({ minLevel: 'info', formatter: () => '', output: () => {} });
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('detects a plain directory as NOT a Git repository', async () => {
    expect(await isInsideGitRepo(tmpDir)).toBe(false);
  });

  it('detects an initialized Git work tree as a repository', async () => {
    const ok = await gitInit(tmpDir);
    if (!ok) return; // git not installed in this environment — skip silently
    expect(await isInsideGitRepo(tmpDir)).toBe(true);
  });

  it('autoCommitAll returns false and warns once in a non-Git workspace', async () => {
    const committed = await autoCommitAll(tmpDir);
    expect(committed).toBe(false);
    expect(warnEntries).toHaveLength(1);
    expect(warnEntries[0].message).toContain('auto-commit failed');
  });

  it('debounces the auto-commit warning to a single entry across repeated failures', async () => {
    await autoCommitAll(tmpDir);
    await autoCommitAll(tmpDir);
    await autoCommitAll(tmpDir);
    expect(warnEntries).toHaveLength(1);
  });

  it('autoStageFile surfaces a debounced warning when git add fails', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'f.txt'), 'x', 'utf-8');
    // Non-Git dir → `git add` exits non-zero → single debounced warn. Awaiting
    // the settle promises pins BOTH spawns' close events inside this test while
    // the debounce is still active (so the 2nd close is suppressed and no late
    // warn can leak into a sibling test after `resetGitWarnDebounce()`).
    await Promise.all([
      autoStageFile(path.join(tmpDir, 'f.txt'), tmpDir),
      autoStageFile(path.join(tmpDir, 'f.txt'), tmpDir),
    ]);

    expect(warnEntries).toHaveLength(1);
    expect(warnEntries[0].message).toContain('auto-stage failed');
  });

  it('does not warn on auto-commit inside a real Git repo', async () => {
    const ok = await gitInit(tmpDir);
    if (!ok) return; // git not installed — skip
    // No staged changes → returns false without treating it as a failure.
    const committed = await autoCommitAll(tmpDir);
    expect(committed).toBe(false);
    expect(warnEntries).toHaveLength(0);
  });
});
