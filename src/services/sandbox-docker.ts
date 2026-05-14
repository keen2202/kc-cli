// DockerSandbox — uses Docker for container-based isolation.
//
// Runs commands inside a minimal container with:
// - Network isolation (--network none by default)
// - Read-only root filesystem (--read-only)
// - Memory and CPU limits
// - Bind-mounted workspace as the only writable directory
// - No-new-privileges security option

import type { SandboxBackend, SandboxOptions } from './sandbox';
import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';

const DEFAULT_IMAGE = 'node:22-alpine';

export class DockerSandbox implements SandboxBackend {
  readonly name = 'docker';

  isAvailable(): boolean {
    try {
      execSync('docker info', { stdio: 'ignore', timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  wrapCommand(command: string, options: SandboxOptions): string {
    const image = DEFAULT_IMAGE;
    const args: string[] = [
      'docker', 'run', '--rm',

      // Network isolation
      '--network', options.allowNetwork ? 'bridge' : 'none',

      // Resource limits
      '--memory', `${options.maxMemoryMb}m`,
      '--cpus', '1',

      // Security hardening
      '--read-only',
      '--security-opt', 'no-new-privileges=true',
      '--cap-drop', 'ALL',
      '--pids-limit', '256',

      // Apply seccomp profile if available
      ...this.seccompArgs(),

      // Temporary filesystems for runtime needs
      '--tmpfs', '/tmp:exec,size=64m',
      '--tmpfs', '/var/tmp:size=32m',
      '--tmpfs', '/run:size=8m',

      // Bind-mount workspace as the only writable directory
      '--mount', `type=bind,source=${options.workDir},target=/work`,

      // Working directory
      '-w', '/work',

      // Hostname
      '--hostname', 'sandbox',

      // Container name for debugging (UUID to avoid concurrent conflicts)
      '--name', `kc-sandbox-${randomBytes(8).toString('hex')}`,

      // Image and command
      image,
      'sh', '-c',
      shellEscape(command),
    ];

    return args.join(' ');
  }

  /**
   * Generate Docker --security-opt seccomp= args if the profile file exists.
   */
  private seccompArgs(): string[] {
    try {
      const profilePath = path.join(__dirname, 'seccomp-profile.json');
      if (fs.existsSync(profilePath)) {
        return ['--security-opt', `seccomp=${profilePath}`];
      }
    } catch {
      // Ignore errors — seccomp is optional
    }
    return [];
  }
}

/**
 * Shell-escape a string for safe embedding in sh -c '...'
 */
function shellEscape(s: string): string {
  // Null bytes are invalid in shell strings
  const sanitized = s.replace(/\0/g, '');
  return "'" + sanitized.replace(/'/g, "'\\''") + "'";
}
