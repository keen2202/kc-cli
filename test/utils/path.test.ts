// Tests for protected-path matching (permissions/protectedPaths)
//
// T31 (round4 §6-M6): the dead `isPathAllowed` / `resolvePathSafely` /
// `validateWritePath` helpers in utils/path.ts were removed, and the tests
// that referenced them were removed with them. Real path security is covered
// by test/utils/path-scope.test.ts against `assertPathWithinWorkspace`.

import { describe, it, expect } from 'vitest';
import { isProtectedPath, containsProtectedPath } from '../../src/permissions/protectedPaths';

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
});
