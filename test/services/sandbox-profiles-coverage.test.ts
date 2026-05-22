import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BubblewrapSandbox,
  SeccompSandbox,
  NoopSandbox,
} from '../../src/services/sandbox-profiles';

describe('BubblewrapSandbox - coverage', () => {
  let sandbox: BubblewrapSandbox;

  beforeEach(() => {
    sandbox = new BubblewrapSandbox();
  });

  describe('name', () => {
    it('should have name bubblewrap', () => {
      expect(sandbox.name).toBe('bubblewrap');
    });
  });

  describe('isAvailable', () => {
    it('should return a boolean', () => {
      const result = sandbox.isAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('wrapCommand', () => {
    it('should include bwrap in the command', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('bwrap');
    });

    it('should include namespace isolation flags', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('--unshare-pid');
      expect(result).toContain('--unshare-ipc');
    });

    it('should unshare net when network disabled', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('--unshare-net');
    });

    it('should not unshare net when network enabled', () => {
      const result = sandbox.wrapCommand('curl test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: true, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).not.toContain('--unshare-net');
    });

    it('should include die-with-parent', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('--die-with-parent');
    });

    it('should bind workspace directory', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/my/project',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('--bind /my/project /my/project');
    });

    it('should handle /tmp workDir', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/tmp/myproject',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('--bind /tmp/myproject /tmp/myproject');
    });

    it('should include read-only mounts', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('--ro-bind /usr /usr');
      expect(result).toContain('--ro-bind /etc /etc');
      expect(result).toContain('--ro-bind /sbin /sbin');
    });

    it('should include proc, tmpfs, and dev', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('--proc /proc');
      expect(result).toContain('--tmpfs /tmp');
      expect(result).toContain('--dev /dev');
    });

    it('should set hostname', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('--hostname sandbox');
      expect(result).toContain('--unshare-uts');
    });

    it('should wrap command with /bin/sh -c', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('/bin/sh -c');
    });

    it('should handle zero memory and CPU limits', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'bubblewrap', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 0, cpuTimeLimitSec: 0,
      });
      expect(result).toContain('bwrap');
      // Should not have ulimit when rlimit not supported
      // Should not have --rlimit-as when memory is 0
      expect(result).not.toContain('ulimit');
    });
  });
});

describe('SeccompSandbox - coverage', () => {
  let sandbox: SeccompSandbox;

  beforeEach(() => {
    sandbox = new SeccompSandbox();
  });

  describe('name', () => {
    it('should have name seccomp', () => {
      expect(sandbox.name).toBe('seccomp');
    });
  });

  describe('isAvailable', () => {
    it('should return a boolean', () => {
      const result = sandbox.isAvailable();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('wrapCommand', () => {
    it('should include the command in output', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'seccomp', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('echo test');
    });

    it('should include ulimit for memory limits', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'seccomp', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toContain('ulimit');
    });

    it('should include timeout for CPU limits', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'seccomp', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 30,
      });
      expect(result).toContain('timeout --signal=KILL 30');
    });

    it('should not include timeout when cpuTimeLimitSec is 0', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'seccomp', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 0,
      });
      expect(result).not.toContain('timeout');
    });

    it('should not set ulimit when maxMemoryMb is 0', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'seccomp', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 0, cpuTimeLimitSec: 0,
      });
      expect(result).not.toContain('ulimit');
    });

    it('should use bwrap with seccomp profile when available', () => {
      const result = sandbox.wrapCommand('echo test', {
        enabled: true, backend: 'seccomp', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      // If seccomp profile exists on disk, bwrap will be used
      if (result.includes('bwrap')) {
        expect(result).toContain('--seccomp');
      }
    });
  });
});

describe('NoopSandbox - coverage', () => {
  let sandbox: NoopSandbox;

  beforeEach(() => {
    sandbox = new NoopSandbox();
  });

  describe('isAvailable', () => {
    it('should always return true', () => {
      expect(sandbox.isAvailable()).toBe(true);
    });
  });

  describe('name', () => {
    it('should be noop', () => {
      expect(sandbox.name).toBe('noop');
    });
  });

  describe('wrapCommand', () => {
    it('should return command unchanged', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = sandbox.wrapCommand('echo hello', {
        enabled: true, backend: 'noop', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(result).toBe('echo hello');
      consoleSpy.mockRestore();
    });

    it('should log warning', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      sandbox.wrapCommand('some long command', {
        enabled: true, backend: 'noop', workDir: '/workspace',
        allowNetwork: false, maxMemoryMb: 512, cpuTimeLimitSec: 60,
      });
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('[sandbox]'));
      consoleSpy.mockRestore();
    });
  });
});
