import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    tmpdir: () => '/tmp',
  };
});

import { WindowsSandbox } from '../../src/services/sandbox-windows';
import * as fs from 'fs';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

describe('WindowsSandbox', () => {
  let sandbox: WindowsSandbox;

  beforeEach(() => {
    sandbox = new WindowsSandbox();
    vi.clearAllMocks();
  });

  describe('name', () => {
    it('should have name windows-sandbox', () => {
      expect(sandbox.name).toBe('windows-sandbox');
    });
  });

  describe('isAvailable', () => {
    it('should return false on non-win32 platforms', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(sandbox.isAvailable()).toBe(false);
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should return false on win32 when sandbox exe does not exist', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockExistsSync.mockReturnValue(false);
      expect(sandbox.isAvailable()).toBe(false);
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should return true on win32 when sandbox exe exists', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockExistsSync.mockReturnValue(true);
      expect(sandbox.isAvailable()).toBe(true);
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });

    it('should return false if existsSync throws', () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      mockExistsSync.mockImplementation(() => { throw new Error('access denied'); });
      expect(sandbox.isAvailable()).toBe(false);
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    });
  });

  describe('wrapCommand', () => {
    it('should return WindowsSandbox.exe command with config path', () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);

      const result = sandbox.wrapCommand('echo hello', {
        enabled: true,
        backend: 'windows-sandbox',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(result).toContain('WindowsSandbox.exe');
      expect(result).toContain('.wsb');
    });

    it('should generate config with network disabled by default', () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);

      sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'windows-sandbox',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      const writtenConfig = mockWriteFileSync.mock.calls[0]?.[1] as string;
      expect(writtenConfig).toContain('Disable');
      expect(writtenConfig).not.toContain('Enable</Networking>');
    });

    it('should generate config with network enabled when allowNetwork is true', () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);

      sandbox.wrapCommand('curl example.com', {
        enabled: true,
        backend: 'windows-sandbox',
        workDir: '/workspace',
        allowNetwork: true,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      const writtenConfig = mockWriteFileSync.mock.calls[0]?.[1] as string;
      expect(writtenConfig).toContain('Enable</Networking>');
    });

    it('should include memory limit when specified', () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);

      sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'windows-sandbox',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 1024,
        cpuTimeLimitSec: 60,
      });

      const writtenConfig = mockWriteFileSync.mock.calls[0]?.[1] as string;
      expect(writtenConfig).toContain('<MemoryInMB>1024</MemoryInMB>');
    });

    it('should escape XML special characters in command', () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);

      sandbox.wrapCommand('echo "hello" & echo <world>', {
        enabled: true,
        backend: 'windows-sandbox',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      const writtenConfig = mockWriteFileSync.mock.calls[0]?.[1] as string;
      expect(writtenConfig).toContain('&amp;');
      expect(writtenConfig).toContain('&lt;');
      expect(writtenConfig).toContain('&gt;');
      expect(writtenConfig).toContain('&quot;');
    });

    it('should create temp directory and write config file', () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);

      sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'windows-sandbox',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      expect(mockMkdirSync).toHaveBeenCalledWith(expect.stringContaining('kc-cli-sandbox'), { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.wsb'),
        expect.any(String),
        'utf-8'
      );
    });

    it('should include mapped folders in config', () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);

      sandbox.wrapCommand('echo test', {
        enabled: true,
        backend: 'windows-sandbox',
        workDir: 'C:\\Users\\dev\\project',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      const writtenConfig = mockWriteFileSync.mock.calls[0]?.[1] as string;
      expect(writtenConfig).toContain('MappedFolder');
      expect(writtenConfig).toContain('C:\\workspace');
    });

    it('should include logon command with escaped command', () => {
      mockMkdirSync.mockReturnValue(undefined);
      mockWriteFileSync.mockReturnValue(undefined);

      sandbox.wrapCommand('dir C:\\', {
        enabled: true,
        backend: 'windows-sandbox',
        workDir: '/workspace',
        allowNetwork: false,
        maxMemoryMb: 512,
        cpuTimeLimitSec: 60,
      });

      const writtenConfig = mockWriteFileSync.mock.calls[0]?.[1] as string;
      expect(writtenConfig).toContain('LogonCommand');
      expect(writtenConfig).toContain('cmd /c');
      expect(writtenConfig).toContain('C:\\output.txt');
    });
  });
});
