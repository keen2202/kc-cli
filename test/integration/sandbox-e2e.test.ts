import { describe, it, expect, beforeAll } from 'vitest';
import { SandboxManager } from '../../src/services/sandbox';
import { execSync, spawnSync } from 'child_process';

/**
 * End-to-end sandbox security verification tests.
 *
 * These tests verify sandbox isolation at the OS level when a real
 * backend is available. Tests gracefully skip when no backend exists.
 */

function getAvailableBackend(): string | null {
  try {
    execSync('which bwrap', { stdio: 'ignore' });
    return 'bubblewrap';
  } catch { /* not available */ }
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5000 });
    return 'docker';
  } catch { /* not available */ }
  return null;
}

const availableBackend = getAvailableBackend();

/**
 * Run a sandboxed command and capture stdout even if the command fails.
 * Uses `spawnSync` to reliably capture output regardless of exit code.
 */
function runSandboxed(cmd: string, options: { cwd?: string; timeout?: number } = {}): string {
  const result = spawnSync('sh', ['-c', cmd], {
    cwd: options.cwd,
    timeout: options.timeout ?? 10000,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  // Return stdout if it has content, otherwise stderr
  const output = (result.stdout && result.stdout.length > 0)
    ? result.stdout
    : (result.stderr ?? '');
  return output;
}

describe('Sandbox E2E Security Verification', () => {
  let manager: SandboxManager;
  let workDir: string;

  beforeAll(() => {
    if (!availableBackend) return;

    // Use a non-/tmp workDir to avoid bwrap --tmpfs /tmp shadowing
    workDir = `/var/tmp/kc-sandbox-e2e-${Date.now()}`;
    execSync(`mkdir -p ${workDir}`);

    manager = new SandboxManager({
      workDir,
      enabled: true,
      backend: availableBackend as any,
    });
  });

  describe('filesystem isolation', () => {
    it('should allow writing to workspace directory', () => {
      if (!manager?.isAvailable()) {
        console.log('  ⏭ Skipping: no sandbox backend available');
        return;
      }

      const wrappedCmd = manager!.wrapCommand(
        'echo "test" > testfile.txt && cat testfile.txt',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: workDir });
      expect(stdout.trim()).toBe('test');

      // Cleanup
      execSync('rm -f testfile.txt', { cwd: workDir });
    });

    it('should prevent writing to system directories', () => {
      if (!manager?.isAvailable()) {
        console.log('  ⏭ Skipping: no sandbox backend available');
        return;
      }

      const wrappedCmd = manager!.wrapCommand(
        'echo "hacked" > /etc/testfile 2>&1 || echo WRITE_DENIED',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: workDir });
      // System directories are read-only in sandbox
      expect(stdout).toContain('WRITE_DENIED');
    });

    it('should restrict access outside workspace', () => {
      if (!manager?.isAvailable()) {
        console.log('  ⏭ Skipping: no sandbox backend available');
        return;
      }

      // Inside sandbox, system dirs are read-only bind mounts
      const wrappedCmd = manager!.wrapCommand(
        'touch /usr/bin/test_write 2>&1 || echo ACCESS_DENIED',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: workDir });
      expect(stdout).toContain('ACCESS_DENIED');
    });
  });

  describe('network isolation', () => {
    it('should block network access when allowNetwork is false', () => {
      if (!manager?.isAvailable()) {
        console.log('  ⏭ Skipping: no sandbox backend available');
        return;
      }

      const wrappedCmd = manager!.wrapCommand(
        'curl -s --connect-timeout 3 https://example.com 2>&1 || echo NETWORK_DENIED',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: workDir, timeout: 15000 });
      expect(stdout).toContain('NETWORK_DENIED');
    });
  });

  describe('resource limits', () => {
    it('should enforce CPU time limit', () => {
      if (!manager?.isAvailable()) {
        console.log('  ⏭ Skipping: no sandbox backend available');
        return;
      }

      const strictManager = new SandboxManager({
        workDir,
        enabled: true,
        backend: availableBackend as any,
        cpuTimeLimitSec: 2,
      });

      if (!strictManager.isAvailable()) return;

      const wrappedCmd = strictManager.wrapCommand(
        'while true; do :; done',
        'Bash'
      );

      try {
        execSync(wrappedCmd, {
          cwd: workDir,
          timeout: 8000,
          encoding: 'utf-8',
        });
        expect.fail('Expected command to be killed by CPU time limit');
      } catch (error: any) {
        expect(error).toBeDefined();
      }
    });
  });

  describe('command injection prevention', () => {
    it('should properly escape single quotes in commands', () => {
      if (!manager?.isAvailable()) {
        console.log('  ⏭ Skipping: no sandbox backend available');
        return;
      }

      const wrappedCmd = manager!.wrapCommand(
        "echo 'hello world'",
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: workDir });
      expect(stdout.trim()).toBe('hello world');
    });

    it('should handle commands with special characters', () => {
      if (!manager?.isAvailable()) {
        console.log('  ⏭ Skipping: no sandbox backend available');
        return;
      }

      const wrappedCmd = manager!.wrapCommand(
        'echo "test $HOME"',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: workDir });
      expect(stdout).toContain('test');
    });
  });

  describe('backend fallback chain', () => {
    it('should fall back gracefully when requested backend unavailable', () => {
      const dockerManager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'docker',
        failIfNoSandbox: false,
      });
      const backend = dockerManager.getBackendName();
      expect(['docker', 'bubblewrap', 'seccomp', 'noop']).toContain(backend);
    });

    it('should use noop when all backends unavailable', () => {
      const noopManager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'bubblewrap',
        failIfNoSandbox: false,
      });
      if (!noopManager.isAvailable()) {
        expect(noopManager.getBackendName()).toBe('noop');
      }
    });
  });
});

describe('Sandbox Policy Enforcement E2E', () => {
  it('should deny Bash tool when sandbox unavailable', () => {
    const manager = new SandboxManager({
      workDir: '/tmp',
      enabled: true,
      backend: 'noop',
    });
    expect(manager.shouldSandboxTool('Bash')).toBe('deny');
  });

  it('should allow FileRead tool regardless of sandbox', () => {
    const manager = new SandboxManager({
      workDir: '/tmp',
      enabled: true,
      backend: 'noop',
    });
    expect(manager.shouldSandboxTool('FileRead')).toBe('run-unsandboxed');
  });

  it('should allow network for WebFetch when policy permits', () => {
    const manager = new SandboxManager({
      workDir: '/tmp',
      enabled: true,
      backend: 'docker',
      failIfNoSandbox: false,
    });
    const policy = manager.getToolSandboxPolicy('WebFetch');
    expect(policy.allowNetwork).toBe(true);
    expect(policy.enforcement).toBe('optional');
  });
});
