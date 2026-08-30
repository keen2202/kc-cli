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
import { SANDBOX_DOCKER_CHECK_TIMEOUT_MS } from '../constants';

const DEFAULT_IMAGE = 'node:22-alpine';

export class DockerSandbox implements SandboxBackend {
  readonly name = 'docker';
  private _available: boolean | null = null;

  /**
   * Probe docker availability asynchronously and cache the result.
   * Call this once during sandbox init to avoid synchronous execSync on the hot path.
   */
  async init(): Promise<void> {
    try {
      execSync('docker info', { stdio: 'ignore', timeout: SANDBOX_DOCKER_CHECK_TIMEOUT_MS });
      this._available = true;
    } catch {
      this._available = false;
    }
  }

  isAvailable(): boolean {
    if (this._available !== null) return this._available;
    // First call: probe synchronously for backward compatibility
    // (callers that don't await init() still get a valid answer)
    try {
      execSync('docker info', { stdio: 'ignore', timeout: SANDBOX_DOCKER_CHECK_TIMEOUT_MS });
      this._available = true;
    } catch {
      this._available = false;
    }
    return this._available;
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
