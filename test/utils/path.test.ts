// Tests for path security utilities

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPathAllowed, resolvePathSafely, validateWritePath } from '../../src/utils/path';
import { isProtectedPath, containsProtectedPath } from '../../src/permissions/protectedPaths';

// Mock fs for symlink tests
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const path = await vi.importActual<typeof import('path')>('path');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      realpath: vi.fn(async (p: string) => {
        // Simulate symlink resolution then normalize
        const resolved = p.includes('/symlink/') ? p.replace('/symlink/', '/real/') : p;
        return path.resolve(resolved);
      }),
    },
  };
});

describe('Path Security', () => {
  describe('isProtectedPath', () => {
    it('should protect /etc/passwd', () => {
      expect(isProtectedPath('/etc/passwd')).toBe(true);
    });

    it('should protect /etc/shadow', () => {
      expect(isProtectedPath('/etc/shadow')).toBe(true);
    });

    it('should protect /etc/sudoers', () => {
      expect(isProtectedPath('/etc/sudoers')).toBe(true);
    });

    it('should protect /etc/ssh/', () => {
      expect(isProtectedPath('/etc/ssh/ssh_config')).toBe(true);
    });

    it('should protect .ssh directories', () => {
      expect(isProtectedPath('/home/user/.ssh/id_rsa')).toBe(true);
      expect(isProtectedPath('/root/.ssh/authorized_keys')).toBe(true);
    });

    it('should protect .gnupg directories', () => {
      expect(isProtectedPath('/home/user/.gnupg/gpg.conf')).toBe(true);
    });

    it('should protect shell profiles', () => {
      expect(isProtectedPath('/home/user/.bashrc')).toBe(true);
      expect(isProtectedPath('/home/user/.zshrc')).toBe(true);
      expect(isProtectedPath('/home/user/.profile')).toBe(true);
    });

    it('should protect .env files', () => {
      expect(isProtectedPath('/project/.env')).toBe(true);
      expect(isProtectedPath('/project/.credentials')).toBe(true);
    });

    it('should protect password files', () => {
      expect(isProtectedPath('/tmp/passwords.txt')).toBe(true);
      expect(isProtectedPath('/tmp/secrets.json')).toBe(true);
    });

    it('should protect /proc/ and /sys/', () => {
      expect(isProtectedPath('/proc/1/status')).toBe(true);
      expect(isProtectedPath('/sys/class/net')).toBe(true);
    });

    it('should not protect normal paths', () => {
      expect(isProtectedPath('/home/user/project/src/index.ts')).toBe(false);
      expect(isProtectedPath('/tmp/test.txt')).toBe(false);
      expect(isProtectedPath('/var/log/app.log')).toBe(false);
    });
  });

  describe('containsProtectedPath', () => {
    it('should detect protected substrings', () => {
      expect(containsProtectedPath('cat /etc/passwd')).toBe(true);
      expect(containsProtectedPath('ls /home/.ssh/')).toBe(true);
    });

    it('should not match normal text', () => {
      expect(containsProtectedPath('npm install')).toBe(false);
      expect(containsProtectedPath('git commit -m "test"')).toBe(false);
    });
  });

  describe('isPathAllowed', () => {
    it('should deny protected paths', async () => {
      const result = await isPathAllowed('/etc/passwd', {
        cwd: '/project',
        allowedDirectories: ['/project'],
        operation: 'read',
      });
      expect(result).toBe('deny');
    });

    it('should allow paths in allowed directories', async () => {
      const result = await isPathAllowed('/project/src/index.ts', {
        cwd: '/project',
        allowedDirectories: ['/project'],
        operation: 'read',
      });
      expect(result).toBe('allow');
    });

    it('should ask for paths outside allowed directories', async () => {
      const result = await isPathAllowed('/tmp/file.txt', {
        cwd: '/project',
        allowedDirectories: ['/project'],
        operation: 'read',
      });
      expect(result).toBe('ask');
    });
  });

  describe('resolvePathSafely', () => {
    it('should resolve symlinks and check safety', async () => {
      const result = await resolvePathSafely('/project/symlink/file.ts', {
        cwd: '/project',
        allowedDirectories: ['/project'],
      });
      // After symlink resolution, path becomes /project/real/file.ts which is still in /project
      expect(result.resolvedPath).toContain('/real/');
    });

    it('should detect symlink escape', async () => {
      const result = await resolvePathSafely('/project/symlink/../../etc/passwd', {
        cwd: '/project',
        allowedDirectories: ['/project'],
      });
      // The mock resolves /symlink/ to /real/, but ../.. still escapes to /etc/passwd
      expect(result.isSafe).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  describe('validateWritePath', () => {
    it('should deny writing to system directories', async () => {
      const result = await validateWritePath('/etc/test.conf', {
        cwd: '/project',
        allowedDirectories: ['/project'],
      });
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('system');
    });

    it('should allow writing to allowed directories', async () => {
      const result = await validateWritePath('/project/src/new-file.ts', {
        cwd: '/project',
        allowedDirectories: ['/project'],
      });
      expect(result.valid).toBe(true);
    });

    it('should deny writing outside allowed directories', async () => {
      const result = await validateWritePath('/tmp/evil.sh', {
        cwd: '/project',
        allowedDirectories: ['/project'],
      });
      expect(result.valid).toBe(false);
    });
  });
});
