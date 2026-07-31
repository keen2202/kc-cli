// Sandbox backend implementations

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import type { SandboxBackend, SandboxOptions } from './sandbox';
import { createLogger } from './logger';

const logger = createLogger('sandbox:profiles');

/**
 * BubblewrapSandbox — uses `bwrap` for namespace isolation on Linux.
 *
 * Bind-mounts the workspace directory as writable and system dirs as read-only.
 * Optionally isolates networking and enforces resource limits.
 */
export class BubblewrapSandbox implements SandboxBackend {
  readonly name = 'bubblewrap';

  /**
   * Cached result of rlimit support detection.
   * - true: bwrap supports --rlimit-* options
   * - false: bwrap does not support --rlimit-* (older versions)
   * - null: not yet detected
   */
  private _supportsRlimit: boolean | null = null;

  /** Cached availability probe (execSync `which bwrap` runs at most once). */
  private _available: boolean | null = null;

  /**
   * Detect whether this bwrap version supports --rlimit-* options.
   * bwrap < 0.10 does not support rlimit.
   */
  private supportsRlimit(): boolean {
    if (this._supportsRlimit !== null) {
      return this._supportsRlimit;
    }
    try {
      // Test with a harmless dry-run to check option recognition
      execSync('bwrap --bind / / --rlimit-cpu 1 -- /bin/true 2>/dev/null', {
        stdio: 'ignore',
        timeout: 3000,
      });
      this._supportsRlimit = true;
    } catch {
      this._supportsRlimit = false;
      logger.debug('bwrap does not support rlimit options');
    }
    return this._supportsRlimit;
  }

  isAvailable(): boolean {
    if (this._available !== null) return this._available;
    try {
      execSync('which bwrap', { stdio: 'ignore' });
      this._available = true;
    } catch {
      logger.debug('bwrap not available');
      this._available = false;
    }
    return this._available;
  }

  wrapCommand(command: string, options: SandboxOptions): string {
    const args: string[] = ['bwrap'];

    // Namespace isolation
    args.push('--unshare-pid');
    args.push('--unshare-ipc');

    // Network isolation
    if (!options.allowNetwork) {
      args.push('--unshare-net');
    }

    // Cleanup
    args.push('--die-with-parent');

    // Bind-mount workspace as read-write.
    // For non-/tmp/ workDirs, bind now. For /tmp/ subdirs, bind AFTER --tmpfs /tmp
    // (see below) to prevent the tmpfs from shadowing it.
    const isTmpWorkDir = options.workDir.startsWith('/tmp/');
    if (!isTmpWorkDir) {
      args.push('--bind', options.workDir, options.workDir);
    }

    // Bind-mount system directories as read-only
    const readOnlyDirs = ['/usr', '/lib', '/lib64', '/bin'];
    for (const dir of readOnlyDirs) {
      args.push('--ro-bind', dir, dir);
    }

    // Bind-mount /etc and /sbin if they exist
    args.push('--ro-bind', '/etc', '/etc');
    args.push('--ro-bind', '/sbin', '/sbin');

    // proc filesystem
    args.push('--proc', '/proc');

    // tmpfs and dev
    args.push('--tmpfs', '/tmp');
    args.push('--dev', '/dev');

    // Re-bind workDir AFTER --tmpfs /tmp when workDir is under /tmp.
    // The tmpfs creates an empty /tmp that shadows host /tmp subdirs;
    // a later bind mount overlays the specific workDir on top.
    if (isTmpWorkDir) {
      args.push('--bind', options.workDir, options.workDir);
    }

    // Resource limits — use bwrap --rlimit-* if supported,
    // otherwise fall back to ulimit wrapper inside the sandbox.
    // CPU time limits are enforced by the executor's timeout
    // (ToolExecutor.executeWithTimeout), so we don't need a nested
    // `timeout` wrapper here which would cause shell-escaping conflicts
    // (shell operators like > && would escape the timeout scope).
    const hasRlimit = this.supportsRlimit();
    let innerCommand = command;

    if (hasRlimit) {
      // Use native bwrap rlimit support
      if (options.maxMemoryMb > 0) {
        const bytes = options.maxMemoryMb * 1024 * 1024;
        args.push(`--rlimit-as`, `${bytes}`);
      }
      if (options.cpuTimeLimitSec > 0) {
        args.push(`--rlimit-cpu`, `${options.cpuTimeLimitSec}`);
      }
    } else {
      // Fall back to ulimit inside the sandbox for memory limits.
      if (options.maxMemoryMb > 0) {
        const kbytes = options.maxMemoryMb * 1024;
        innerCommand = `ulimit -v ${kbytes} 2>/dev/null; ${command}`;
      }
    }

    // Set hostname (requires --unshare-uts in bwrap >= 0.7)
    args.push('--unshare-uts');
    args.push('--hostname', 'sandbox');

    // The actual command
    args.push('--', '/bin/sh', '-c', shellEscape(innerCommand));

    return args.join(' ');
  }
}

/**
 * SeccompSandbox — uses Linux seccomp-bpf for syscall filtering
 * with `timeout` and `ulimit` for resource limits.
 *
 * Only allows whitelisted syscalls (read/write/execve etc.) and
 * explicitly blocks dangerous syscalls (ptrace, mount, reboot etc.)
 */
export class SeccompSandbox implements SandboxBackend {
  readonly name = 'seccomp';

  /** Cached availability probe (execSync/readFileSync run at most once). */
  private _available: boolean | null = null;

  isAvailable(): boolean {
    if (this._available !== null) return this._available;
    try {
      // Only supported on Linux
      if (process.platform !== 'linux') {
        this._available = false;
        return false;
      }
      // Verify timeout command is available
      execSync('which timeout', { stdio: 'ignore', timeout: 2000 });
      // Verify seccomp is enabled in kernel via the standard API
      const seccompAvail = fs.readFileSync('/proc/sys/kernel/seccomp/actions_avail', 'utf-8');
      this._available = seccompAvail.includes('errno');
    } catch {
      this._available = false;
    }
    return this._available;
  }

  /**
   * Get the path to the seccomp profile JSON file.
   * Returns null if the profile file is not found.
   */
  private getSeccompProfilePath(): string | null {
    try {
      // The seccomp profile is in the same directory as this file
      const profilePath = fileURLToPath(new URL('./seccomp-profile.json', import.meta.url));
      if (fs.existsSync(profilePath)) {
        return profilePath;
      }
      return null;
    } catch {
      return null;
    }
  }

  wrapCommand(command: string, options: SandboxOptions): string {
    const parts: string[] = [];

    // Resource limits via ulimit
    if (options.maxMemoryMb > 0) {
      const kbytes = options.maxMemoryMb * 1024;
      parts.push(`ulimit -v ${kbytes} 2>/dev/null;`);
    }

    // CPU time limit via timeout command
    const timeoutCmd = options.cpuTimeLimitSec > 0
      ? `timeout --signal=KILL ${options.cpuTimeLimitSec}`
      : '';

    // Seccomp profile wrapper (if available)
    const seccompPath = this.getSeccompProfilePath();
    let execCmd = `/bin/sh -c ${shellEscape(command)}`;

    if (seccompPath) {
      // Use bwrap with seccomp profile for syscall filtering
      const bwrapArgs = [
        'bwrap',
        '--unshare-pid',
        '--unshare-ipc',
        '--die-with-parent',
        '--bind', options.workDir, options.workDir,
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/lib', '/lib',
        '--ro-bind', '/lib64', '/lib64',
        '--ro-bind', '/bin', '/bin',
        '--proc', '/proc',
        '--tmpfs', '/tmp',
        '--dev', '/dev',
        '--seccomp', seccompPath,
        '--',
      ];
      if (timeoutCmd) {
        parts.push(bwrapArgs.join(' '));
        parts.push(timeoutCmd);
      } else {
        parts.push(bwrapArgs.join(' '));
      }
      execCmd = `/bin/sh -c ${shellEscape(command)}`;
    }

    parts.push(execCmd);

    return parts.filter(Boolean).join(' ');
  }
}

/**
 * NoopSandbox — pass-through for platforms without sandbox support.
 * Logs a warning but executes the command unchanged.
 */
export class NoopSandbox implements SandboxBackend {
  readonly name = 'noop';

  isAvailable(): boolean {
    return true; // Always available
  }

  wrapCommand(command: string, _options: SandboxOptions): string {
    console.warn(
      '[sandbox] No sandbox backend available — command running without isolation: ' +
        command.slice(0, 80)
    );
    return command;
  }
}

/**
 * Shell-escape a string for safe embedding in /bin/sh -c '...'
 */
/**
 * Shell-escape a string for safe embedding in sh -c '...'
 * Strips null bytes (invalid in shell) and wraps in single quotes.
 */
function shellEscape(s: string): string {
  const sanitized = s.replace(/\0/g, '');
  return "'" + sanitized.replace(/'/g, "'\\''") + "'";
}
