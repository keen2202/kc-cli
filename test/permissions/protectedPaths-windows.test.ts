import { describe, it, expect } from 'vitest';
import {
  containsProtectedPath,
  isProtectedPath,
  isSystemWriteDirectory,
  normalizePathForMatch,
} from '../../src/permissions/protectedPaths';

describe('protectedPaths — Windows coverage (H3)', () => {
  describe('normalizePathForMatch', () => {
    it('converts backslashes to forward slashes', () => {
      expect(normalizePathForMatch('C:\\Users\\me\\.ssh\\id_rsa')).toBe('c:/Users/me/.ssh/id_rsa');
    });

    it('lower-cases the drive letter only', () => {
      expect(normalizePathForMatch('D:\\Windows\\System32')).toBe('d:/Windows/System32');
    });

    it('expands %USERPROFILE% to the home marker', () => {
      expect(normalizePathForMatch('%USERPROFILE%\\.aws\\credentials')).toBe('~/.aws/credentials');
    });

    it('leaves Unix paths unchanged', () => {
      expect(normalizePathForMatch('/home/user/.ssh/id_rsa')).toBe('/home/user/.ssh/id_rsa');
    });

    it('handles empty input', () => {
      expect(normalizePathForMatch('')).toBe('');
    });
  });

  describe('containsProtectedPath — Windows credential/system paths', () => {
    it('flags C:\\Users\\*\\.ssh', () => {
      expect(containsProtectedPath('C:\\Users\\me\\.ssh\\id_rsa')).toBe(true);
    });

    it('flags .aws\\credentials with backslashes', () => {
      expect(containsProtectedPath('C:\\Users\\me\\.aws\\credentials')).toBe(true);
    });

    it('flags %USERPROFILE%\\.azure', () => {
      expect(containsProtectedPath('%USERPROFILE%\\.azure\\accessTokens.json')).toBe(true);
    });

    it('flags .kube\\config', () => {
      expect(containsProtectedPath('C:\\Users\\me\\.kube\\config')).toBe(true);
    });

    it('flags .docker\\config.json', () => {
      expect(containsProtectedPath('C:\\Users\\me\\.docker\\config.json')).toBe(true);
    });

    it('flags System32\\config (SAM/SYSTEM hives)', () => {
      expect(containsProtectedPath('C:\\Windows\\System32\\config\\SAM')).toBe(true);
    });

    it('flags System32 drivers\\etc\\hosts', () => {
      expect(containsProtectedPath('C:\\Windows\\System32\\drivers\\etc\\hosts')).toBe(true);
    });

    it('flags gcloud under AppData\\Roaming', () => {
      expect(containsProtectedPath('C:\\Users\\me\\AppData\\Roaming\\gcloud\\credentials.db')).toBe(true);
    });

    it('flags Microsoft\\Crypto keys', () => {
      expect(containsProtectedPath('C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Crypto\\RSA\\key')).toBe(true);
    });

    it('does not flag ordinary Windows source paths', () => {
      expect(containsProtectedPath('C:\\Users\\me\\project\\src\\index.ts')).toBe(false);
    });
  });

  describe('isProtectedPath — Windows credential paths', () => {
    it('flags normalized .aws credentials', () => {
      expect(isProtectedPath('C:\\Users\\me\\.aws\\credentials')).toBe(true);
    });

    it('flags System32 config hive', () => {
      expect(isProtectedPath('C:\\Windows\\System32\\config\\SYSTEM')).toBe(true);
    });

    it('does not flag a normal project file', () => {
      expect(isProtectedPath('C:\\Users\\me\\project\\README.md')).toBe(false);
    });
  });

  describe('isSystemWriteDirectory — Windows system dirs', () => {
    it('denies writes under C:\\Windows', () => {
      expect(isSystemWriteDirectory('C:\\Windows\\System32\\evil.dll')).toBe(true);
    });

    it('denies writes under C:\\Program Files', () => {
      expect(isSystemWriteDirectory('C:\\Program Files\\App\\payload.exe')).toBe(true);
    });

    it('denies writes under C:\\Program Files (x86)', () => {
      expect(isSystemWriteDirectory('C:\\Program Files (x86)\\App\\payload.exe')).toBe(true);
    });

    it('denies writes under C:\\ProgramData', () => {
      expect(isSystemWriteDirectory('C:\\ProgramData\\startup\\run.bat')).toBe(true);
    });

    it('is case-insensitive on drive and directory', () => {
      expect(isSystemWriteDirectory('c:\\WINDOWS\\system32\\x')).toBe(true);
    });

    it('allows writes under a user project directory', () => {
      expect(isSystemWriteDirectory('C:\\Users\\me\\project\\out.txt')).toBe(false);
    });
  });

  describe('Unix regression — existing behavior preserved', () => {
    it('still flags /etc/passwd', () => {
      expect(containsProtectedPath('/etc/passwd')).toBe(true);
    });

    it('still flags ~/.ssh', () => {
      expect(containsProtectedPath('/home/user/.ssh/id_rsa')).toBe(true);
    });

    it('still denies /etc/ writes', () => {
      expect(isSystemWriteDirectory('/etc/cron.d/evil')).toBe(true);
    });

    it('still denies /usr/ writes', () => {
      expect(isSystemWriteDirectory('/usr/bin/x')).toBe(true);
    });

    it('still allows /home/user writes', () => {
      expect(isSystemWriteDirectory('/home/user/file.txt')).toBe(false);
    });

    it('does not flag a normal Unix source path', () => {
      expect(containsProtectedPath('/home/user/project/src/index.ts')).toBe(false);
    });
  });
});
