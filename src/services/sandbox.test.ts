import { describe, it, expect } from 'vitest';
import { SandboxManager } from './sandbox';
import { BubblewrapSandbox, SeccompSandbox, NoopSandbox } from './sandbox-profiles';
import type { SandboxOptions } from './sandbox';

const baseOptions: SandboxOptions = {
  enabled: true,
  backend: 'bubblewrap',
  workDir: '/workspace',
  allowNetwork: false,
  maxMemoryMb: 512,
  cpuTimeLimitSec: 60,
};

describe('BubblewrapSandbox', () => {
  const sandbox = new BubblewrapSandbox();

  it('has name "bubblewrap"', () => {
    expect(sandbox.name).toBe('bubblewrap');
  });

  it('wraps command with bwrap args', () => {
    const wrapped = sandbox.wrapCommand('ls -la', baseOptions);
    expect(wrapped).toContain('bwrap');
    expect(wrapped).toContain('--unshare-pid');
    expect(wrapped).toContain('--unshare-net');
    expect(wrapped).toContain('--die-with-parent');
    expect(wrapped).toContain('--bind /workspace /workspace');
    expect(wrapped).toContain('--ro-bind /usr /usr');
  });

  it('skips --unshare-net when allowNetwork is true', () => {
    const wrapped = sandbox.wrapCommand('curl http://example.com', { ...baseOptions, allowNetwork: true });
    expect(wrapped).not.toContain('--unshare-net');
  });

  it('includes resource limits', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain('--rlimit-as 536870912');
    expect(wrapped).toContain('--rlimit-cpu 60');
  });

  it('escapes single quotes in commands', () => {
    const wrapped = sandbox.wrapCommand("echo 'hello world'", baseOptions);
    expect(wrapped).toContain("'\\''");
  });
});

describe('SeccompSandbox', () => {
  const sandbox = new SeccompSandbox();

  it('has name "seccomp"', () => {
    expect(sandbox.name).toBe('seccomp');
  });

  it('includes ulimit for memory', () => {
    const wrapped = sandbox.wrapCommand('ls -la', baseOptions);
    expect(wrapped).toContain('ulimit -v');
    expect(wrapped).toContain('524288');
  });

  it('includes timeout', () => {
    const wrapped = sandbox.wrapCommand('ls -la', baseOptions);
    expect(wrapped).toContain('timeout --signal=KILL 60');
  });

  it('omits ulimit when maxMemoryMb is 0', () => {
    const wrapped = sandbox.wrapCommand('ls', { ...baseOptions, maxMemoryMb: 0 });
    expect(wrapped).not.toContain('ulimit');
  });
});

describe('NoopSandbox', () => {
  const sandbox = new NoopSandbox();

  it('has name "noop"', () => {
    expect(sandbox.name).toBe('noop');
  });

  it('is always available', () => {
    expect(sandbox.isAvailable()).toBe(true);
  });

  it('passes commands through unchanged', () => {
    expect(sandbox.wrapCommand('ls -la', baseOptions)).toBe('ls -la');
  });
});

describe('SandboxManager', () => {
  it('uses noop when disabled', () => {
    const manager = new SandboxManager({ enabled: false, workDir: '/workspace' });
    expect(manager.getBackendName()).toBe('noop');
  });

  it('passes through when disabled', () => {
    const manager = new SandboxManager({ enabled: false, workDir: '/workspace' });
    expect(manager.wrapCommand('echo test')).toBe('echo test');
  });

  it('uses requested noop backend', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'noop', workDir: '/workspace' });
    expect(manager.getBackendName()).toBe('noop');
  });

  it('falls back through backend chain', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'bubblewrap', workDir: '/workspace' });
    expect(['bubblewrap', 'seccomp', 'noop']).toContain(manager.getBackendName());
  });

  it('wrapCommand returns a string', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'noop', workDir: '/workspace' });
    expect(typeof manager.wrapCommand('echo test')).toBe('string');
  });
});
