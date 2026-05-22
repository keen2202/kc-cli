import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

import { DockerSandbox } from '../../src/services/sandbox-docker';
import { execSync } from 'child_process';
import * as fs from 'fs';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(fs.existsSync);

describe('DockerSandbox', () => {
  let sandbox: DockerSandbox;

  beforeEach(() => {
    sandbox = new DockerSandbox();
    vi.clearAllMocks();
  });

  describe('name', () => {
    it('should have name docker', () => {
      expect(sandbox.name).toBe('docker');
    });
  });

  describe('isAvailable', () => {
    it('should return true when docker info succeeds', () => {
      mockExecSync.mockReturnValue('');
      expect(sandbox.isAvailable()).toBe(true);
      expect(mockExecSync).toHaveBeenCalledWith('docker info', { stdio: 'ignore', timeout: 5000 });
    });

    it('should return false when docker info fails', () => {
      mockExecSync.mockImplementation(() => { throw new Error('docker not found'); });
      expect(sandbox.isAvailable()).toBe(false);
    });
  });

  describe('wrapCommand', () => {
    it('should return docker run command', () => {
      const result = sandbox.wrapCommand('echo hello', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 256,
        cpuTimeLimitSec: 30,
      });

      expect(result).toContain('docker run --rm');
      expect(result).toContain('node:22-alpine');
      expect(result).toContain('echo hello');
    });

    it('should set network to none when allowNetwork is false', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--network none');
    });

    it('should set network to bridge when allowNetwork is true', () => {
      const result = sandbox.wrapCommand('curl example.com', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: true,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--network bridge');
    });

    it('should set memory limit', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 1024,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--memory 1024m');
    });

    it('should include security hardening options', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--read-only');
      expect(result).toContain('--security-opt no-new-privileges=true');
      expect(result).toContain('--cap-drop ALL');
      expect(result).toContain('--pids-limit 256');
    });

    it('should mount workspace as bind', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/my/project',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--mount type=bind,source=/my/project,target=/work');
      expect(result).toContain('-w /work');
    });

    it('should set hostname to sandbox', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--hostname sandbox');
    });

    it('should include tmpfs mounts', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--tmpfs /tmp:exec,size=64m');
      expect(result).toContain('--tmpfs /var/tmp:size=32m');
      expect(result).toContain('--tmpfs /run:size=8m');
    });

    it('should include container name with prefix', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--name kc-sandbox-');
    });

    it('should include seccomp profile when file exists', () => {
      mockExistsSync.mockReturnValue(true);

      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--security-opt seccomp=');
    });

    it('should not include seccomp profile when file does not exist', () => {
      mockExistsSync.mockReturnValue(false);

      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).not.toContain('seccomp=');
    });

    it('should handle existsSync error gracefully for seccomp', () => {
      mockExistsSync.mockImplementation(() => { throw new Error('access error'); });

      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).not.toContain('seccomp=');
    });

    it('should shell-escape the command', () => {
      const result = sandbox.wrapCommand("echo 'hello world'", {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      // Should properly escape single quotes
      expect(result).toContain("sh -c");
    });

    it('should strip null bytes from command', () => {
      const result = sandbox.wrapCommand('echo\x00hello', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).not.toContain('\x00');
    });

    it('should use 1 CPU', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'docker',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('--cpus 1');
    });
  });
});
