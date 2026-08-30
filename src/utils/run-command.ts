// Run a shell command on the host with timeout / spawn-failure discrimination.
//
// round4 §3-R6: the test verification gate used `spawn('bash', ['-c', cmd])`.
// `bash` does not exist on a stock Windows install, so the spawn failed with
// ENOENT, the gate caught the error and returned "tests not found" — a silent
// no-op that let the agent exit with failing tests on every Windows machine.
//
// This helper always goes through the platform's default shell (`shell: true`
// → cmd.exe on Windows, /bin/sh elsewhere) and reports the three outcomes the
// verification gate needs to tell apart:
//   * completed      → { code, timedOut: false }
//   * killed by us   → { code: -1, timedOut: true }
//   * spawn failed   → rejects (ENOENT, missing shell, …)

import { spawn, spawnSync } from 'node:child_process';

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or -1 when the command was killed by the timeout. */
  code: number;
  /** True when the timeout fired and the child was terminated. */
  timedOut: boolean;
}

export interface RunCommandOptions {
  cwd?: string;
  /** Kill the command after this many milliseconds. Omit for no timeout. */
  timeoutMs?: number;
  /** Override the child environment. Defaults to inheriting the parent's. */
  env?: Record<string, string>;
  /** Cap on captured output per stream (default 8 MiB). */
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;
const FORCE_KILL_GRACE_MS = 2_000;

/**
 * Terminate a shell command *and everything it started*.
 *
 * With `shell: true` the direct child is the shell; killing it leaves the
 * command's own process running and holding the stdio pipes open, so 'close'
 * never fires and the timeout would hang forever. On POSIX the child is spawned
 * detached (its own process group) so the whole group can be signalled; on
 * Windows `taskkill /T` walks the tree.
 */
function killCommandTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill();
    return;
  }

  if (process.platform === 'win32') {
    const killed = spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (killed.status === 0) return;
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      /* fall through to killing the shell directly */
    }
  }
  child.kill('SIGKILL');
}

export function runCommand(command: string, options: RunCommandOptions = {}): Promise<RunCommandResult> {
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise<RunCommandResult>((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
      // POSIX only: own process group so the timeout can kill the whole tree.
      // On Windows `detached` would open a new console window.
      detached: process.platform !== 'win32',
      ...(options.env ? { env: options.env } : {}),
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    // Own the timer rather than using `spawn`'s `timeout` option: whether the
    // child reports `killed`/SIGTERM afterwards differs between POSIX and
    // Windows, and the gate must classify timeouts identically on both.
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    if (options.timeoutMs && options.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        killCommandTree(child);
        // Second swing in case the tree kill was only partially effective.
        forceKillTimer = setTimeout(() => killCommandTree(child), FORCE_KILL_GRACE_MS);
        forceKillTimer.unref?.();
      }, options.timeoutMs);
      killTimer.unref?.();
    }

    const append = (chunk: Buffer, which: 'stdout' | 'stderr'): void => {
      const text = chunk.toString();
      if ((which === 'stdout' ? stdout.length : stderr.length) + text.length > maxBuffer) {
        truncated = true;
        return;
      }
      if (which === 'stdout') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'));

    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr: truncated ? `${stderr}\n[output truncated]` : stderr,
        code: timedOut ? -1 : (code ?? 1),
        timedOut,
      });
    });

    // Infrastructure failure (missing shell, ENOENT, …) is not a command
    // result — reject so callers can classify it separately.
    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });
  });
}
