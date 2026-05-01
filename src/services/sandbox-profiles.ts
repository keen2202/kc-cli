// Sandbox backend implementations

import type { SandboxBackend, SandboxOptions } from './sandbox';

/**
 * BubblewrapSandbox — uses `bwrap` for namespace isolation on Linux.
 *
 * Bind-mounts the workspace directory as writable and system dirs as read-only.
 * Optionally isolates networking and enforces resource limits.
 */
export class BubblewrapSandbox implements SandboxBackend {
  readonly name = 'bubblewrap';

  isAvailable(): boolean {
    try {
      const { execSync } = require('child_process');
      execSync('which bwrap', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
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

    // Bind-mount workspace as read-write
    args.push('--bind', options.workDir, options.workDir);

    // Bind-mount system directories as read-only
    const readOnlyDirs = ['/usr', '/lib', '/lib64', '/bin'];
    for (const dir of readOnlyDirs) {
      args.push('--ro-bind', dir, dir);
    }

    // Bind-mount /etc and /sbin if they exist
    args.push('--ro-bind', '/etc', '/etc');
    args.push('--ro-bind', '/sbin', '/sbin');

    // proc and tmp filesystems
    args.push('--proc', '/proc');
    args.push('--tmpfs', '/tmp');
    args.push('--dev', '/dev');

    // Resource limits via rlimit
    if (options.maxMemoryMb > 0) {
      const bytes = options.maxMemoryMb * 1024 * 1024;
      args.push(`--rlimit-as`, `${bytes}`);
    }
    if (options.cpuTimeLimitSec > 0) {
      args.push(`--rlimit-cpu`, `${options.cpuTimeLimitSec}`);
    }

    // Set hostname
    args.push('--hostname', 'sandbox');

    // The actual command
    args.push('--', '/bin/sh', '-c', shellEscape(command));

    return args.join(' ');
  }
}

/**
 * SeccompSandbox — lightweight fallback that uses `timeout` and `ulimit`
 * for resource limits when bubblewrap is not available.
 */
export class SeccompSandbox implements SandboxBackend {
  readonly name = 'seccomp';

  isAvailable(): boolean {
    // Available on any POSIX system with timeout and ulimit
    try {
      const { execSync } = require('child_process');
      execSync('which timeout', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
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
    if (options.cpuTimeLimitSec > 0) {
      parts.push(`timeout --signal=KILL ${options.cpuTimeLimitSec}`);
    }

    parts.push('/bin/sh', '-c', shellEscape(command));

    return parts.join(' ');
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
function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
