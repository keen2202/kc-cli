// Host command runner — round4 §3-R6
//
// The verification gate used to `spawn('bash', ['-c', cmd])`. On stock Windows
// that spawn fails with ENOENT, the caller caught it and reported "tests not
// found" — so the gate was a silent no-op on every Windows machine.

import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import { runCommand } from '../../src/utils/run-command';

/** A command that behaves identically on cmd.exe and /bin/sh. */
const echoHello =
  process.platform === 'win32' ? 'echo hello' : 'printf hello';

describe('runCommand', () => {
  it('runs through the platform default shell', async () => {
    const result = await runCommand(echoHello, { cwd: os.tmpdir() });
    expect(result.stdout.trim()).toBe('hello');
    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('does not depend on bash being installed', async () => {
    // The old code path required `bash` on PATH. This assertion fails on a
    // Windows box without Git Bash if `shell: true` is ever dropped.
    const result = await runCommand(echoHello, { cwd: os.tmpdir() });
    expect(result.code).toBe(0);
  });

  it('propagates a non-zero exit code', async () => {
    const result = await runCommand(
      process.platform === 'win32' ? 'exit /b 3' : 'exit 3',
      { cwd: os.tmpdir() },
    );
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('reports timeouts with code -1 and timedOut true', async () => {
    // A node child is reliably killable on every platform (unlike `ping`/`sleep`
    // in some sandboxes), so this exercises the timeout path itself.
    const sleep = `"${process.execPath}" -e "setTimeout(() => {}, 30000)"`;

    const started = Date.now();
    const result = await runCommand(sleep, { cwd: os.tmpdir(), timeoutMs: 500 });

    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(-1);
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  it('rejects when the command cannot be spawned at all', async () => {
    // A command that exists nowhere; with shell:true the shell still exits
    // non-zero, so use an impossible cwd to force a spawn-level error.
    await expect(
      runCommand(echoHello, { cwd: '/definitely/not/a/real/directory/kc' }),
    ).rejects.toBeDefined();
  });

  it('captures stderr separately from stdout', async () => {
    const result = await runCommand(
      process.platform === 'win32' ? 'echo oops 1>&2' : 'echo oops >&2',
      { cwd: os.tmpdir() },
    );
    expect(result.stderr).toContain('oops');
    expect(result.stdout).not.toContain('oops');
  });
});
