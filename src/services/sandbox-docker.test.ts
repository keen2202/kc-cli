import { describe, it, expect } from 'vitest';
import { DockerSandbox } from './sandbox-docker';
import type { SandboxOptions } from './sandbox';

const baseOptions: SandboxOptions = {
  enabled: true,
  backend: 'docker',
  workDir: '/workspace',
  allowNetwork: false,
  maxMemoryMb: 512,
  cpuTimeLimitSec: 60,
};

describe('DockerSandbox', () => {
  const sandbox = new DockerSandbox();

  it('has name "docker"', () => {
    expect(sandbox.name).toBe('docker');
  });

  it('wraps command with docker run args', () => {
    const wrapped = sandbox.wrapCommand('ls -la', baseOptions);
    expect(wrapped).toContain('docker');
    expect(wrapped).toContain('run');
    expect(wrapped).toContain('--rm');
  });

  it('isolates network by default', () => {
    const wrapped = sandbox.wrapCommand('curl http://example.com', baseOptions);
    expect(wrapped).toContain('--network none');
    expect(wrapped).not.toContain('--network bridge');
  });

  it('allows network when configured', () => {
    const wrapped = sandbox.wrapCommand('curl http://example.com', { ...baseOptions, allowNetwork: true });
    expect(wrapped).toContain('--network bridge');
    expect(wrapped).not.toContain('--network none');
  });

  it('sets memory limit', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain('--memory 512m');
  });

  it('uses read-only root filesystem', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain('--read-only');
  });

  it('sets no-new-privileges', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain('--security-opt');
    expect(wrapped).toContain('no-new-privileges=true');
  });

  it('mounts workspace as writable', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain(`type=bind,source=/workspace,target=/work`);
  });

  it('sets working directory to /work', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain('-w /work');
  });

  it('uses node:22-alpine as default image', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain('node:22-alpine');
  });

  it('escapes single quotes in commands', () => {
    const wrapped = sandbox.wrapCommand("echo 'hello world'", baseOptions);
    expect(wrapped).toContain("'\\''");
  });

  it('includes tmpfs mounts', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain('--tmpfs');
    expect(wrapped).toContain('/tmp:exec,size=64m');
  });

  it('sets sandbox hostname', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    expect(wrapped).toContain('--hostname sandbox');
  });

  it('uses custom memory limit', () => {
    const wrapped = sandbox.wrapCommand('ls', { ...baseOptions, maxMemoryMb: 1024 });
    expect(wrapped).toContain('--memory 1024m');
  });
});
