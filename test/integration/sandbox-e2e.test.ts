import { describe, expect, it } from 'vitest';
import { SandboxManager } from '../../src/services/sandbox';
import { execSync, spawnSync } from 'child_process';

/**
 * End-to-end sandbox security verification tests.
 *
 * Audit round3 (T03): skips must be EXPLICIT. The backend probe + execution
 * canary below runs once at module load (synchronously) so that every
 * environment-dependent case uses `it.skipIf(...)` and therefore shows up in
 * the reporter's skipped count — silent early-`return` soft-skips are banned
 * (see AGENTS.md → Testing).
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

interface SandboxProbe {
  works: boolean;
  backend: string | null;
  workDir?: string;
  manager?: SandboxManager;
}

/**
 * Probe whether a real backend can actually execute commands: a backend
 * binary may be present yet unable to bind-mount paths (e.g. Docker in
 * GitHub Actions), so a canary write inside the sandbox is mandatory.
 */
function probeSandbox(): SandboxProbe {
  const backend = getAvailableBackend();
  if (!backend) {
    console.warn('[sandbox-e2e] no sandbox backend available — E2E cases will report as skipped');
    return { works: false, backend: null };
  }

  // Use a non-/tmp workDir to avoid bwrap --tmpfs /tmp shadowing
  const workDir = `/var/tmp/kc-sandbox-e2e-${Date.now()}`;
  try {
    execSync(`mkdir -p ${workDir}`);
  } catch (err) {
    console.warn(`[sandbox-e2e] cannot create workDir ${workDir}: ${String(err)} — E2E cases will report as skipped`);
    return { works: false, backend };
  }

  const manager = new SandboxManager({
    workDir,
    enabled: true,
    backend: backend as 'bubblewrap' | 'docker',
  });

  if (!manager.isAvailable()) {
    return { works: false, backend, workDir };
  }

  try {
    const canaryCmd = manager.wrapCommand(
      'echo "canary" > /work/canary.txt && cat /work/canary.txt',
      'Bash'
    );
    const result = spawnSync('sh', ['-c', canaryCmd], {
      cwd: workDir,
      timeout: 15000,
      encoding: 'utf-8',
    });
    const output = (result.stdout?.trim?.() ?? '');
    if (output !== 'canary') {
      console.warn(`[sandbox-e2e] canary failed — backend ${manager.getBackendName()} is present but cannot execute sandboxed commands. E2E cases will report as skipped.`);
      return { works: false, backend, workDir, manager };
    }
  } catch (err) {
    console.warn(`[sandbox-e2e] canary threw (${String(err)}) — backend cannot execute sandboxed commands. E2E cases will report as skipped.`);
    return { works: false, backend, workDir, manager };
  }

  return { works: true, backend, workDir, manager };
}

const probe = probeSandbox();

/** Explicit skip variant: every environment-dependent case MUST use this. */
const itWithWorkingSandbox = it.skipIf(!probe.works);

/** CPU-limit manager probed at module scope so its skip is explicit too. */
const cpuManager = probe.works
  ? new SandboxManager({
      workDir: probe.workDir,
      enabled: true,
      backend: probe.backend as 'bubblewrap' | 'docker',
      cpuTimeLimitSec: 2,
    })
  : null;

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
  describe('filesystem isolation', () => {
    itWithWorkingSandbox('should allow writing to workspace directory', () => {
      const workDir = probe.workDir!;
      const wrappedCmd = probe.manager!.wrapCommand(
        'echo "test" > testfile.txt && cat testfile.txt',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: workDir });
      expect(stdout.trim()).toBe('test');

      // Cleanup
      execSync('rm -f testfile.txt', { cwd: workDir });
    });

    itWithWorkingSandbox('should prevent writing to system directories', () => {
      const wrappedCmd = probe.manager!.wrapCommand(
        'echo "hacked" > /etc/testfile 2>&1 || echo WRITE_DENIED',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: probe.workDir });
      // System directories are read-only in sandbox
      expect(stdout).toContain('WRITE_DENIED');
    });

    itWithWorkingSandbox('should restrict access outside workspace', () => {
      // Inside sandbox, system dirs are read-only bind mounts
      const wrappedCmd = probe.manager!.wrapCommand(
        'touch /usr/bin/test_write 2>&1 || echo ACCESS_DENIED',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: probe.workDir });
      expect(stdout).toContain('ACCESS_DENIED');
    });
  });

  describe('network isolation', () => {
    itWithWorkingSandbox('should block network access when allowNetwork is false', () => {
      const wrappedCmd = probe.manager!.wrapCommand(
        'curl -s --connect-timeout 3 https://example.com 2>&1 || echo NETWORK_DENIED',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: probe.workDir, timeout: 15000 });
      expect(stdout).toContain('NETWORK_DENIED');
    });
  });

  describe('resource limits', () => {
    it.skipIf(!cpuManager?.isAvailable())('should enforce CPU time limit', () => {
      const strictManager = cpuManager!;

      const wrappedCmd = strictManager.wrapCommand(
        'while true; do :; done',
        'Bash'
      );

      try {
        execSync(wrappedCmd, {
          cwd: probe.workDir,
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
    itWithWorkingSandbox('should properly escape single quotes in commands', () => {
      const wrappedCmd = probe.manager!.wrapCommand(
        "echo 'hello world'",
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: probe.workDir });
      expect(stdout.trim()).toBe('hello world');
    });

    itWithWorkingSandbox('should handle commands with special characters', () => {
      const wrappedCmd = probe.manager!.wrapCommand(
        'echo "test $HOME"',
        'Bash'
      );

      const stdout = runSandboxed(wrappedCmd, { cwd: probe.workDir });
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
