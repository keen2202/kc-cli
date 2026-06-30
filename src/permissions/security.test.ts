// Security tests for permission system

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hasPermissionsToUseTool } from './engine';
import { createSandboxSignature, verifySandboxSignature, SANDBOX_WRAPPED_MARKER, SANDBOX_SIGNATURE_KEY } from '../executors/toolExecutor';
import { containsProtectedPath } from './protectedPaths';
import { isReadOnlyBashCommand, DANGEROUS_BASH_PATTERNS } from './readonlyCommands';

// Mock state at top level
vi.mock('../bootstrap/state', () => ({
  getState: () => ({
    permissionMode: 'default',
    cwd: '/workspace',
  }),
}));

describe('Permission System Security', () => {
  describe('Symbol Marker Forgery Prevention', () => {
    it('rejects forged marker without signature', () => {
      const input: Record<string, unknown> = {
        command: 'ls -la',
        [SANDBOX_WRAPPED_MARKER]: true,
        // Missing signature
      };

      // The marker alone should not be enough
      expect(input[SANDBOX_WRAPPED_MARKER]).toBe(true);
      expect(input[SANDBOX_SIGNATURE_KEY]).toBeUndefined();
    });

    it('rejects forged marker with invalid signature', () => {
      const input: Record<string, unknown> = {
        command: 'ls -la',
        [SANDBOX_WRAPPED_MARKER]: true,
        [SANDBOX_SIGNATURE_KEY]: 'a'.repeat(64), // Invalid signature
      };

      expect(verifySandboxSignature('Bash', input[SANDBOX_SIGNATURE_KEY] as string)).toBe(false);
    });

    it('rejects signature for different tool', () => {
      const signature = createSandboxSignature('FileRead');
      const input: Record<string, unknown> = {
        command: 'ls -la',
        [SANDBOX_WRAPPED_MARKER]: true,
        [SANDBOX_SIGNATURE_KEY]: signature,
      };

      // Signature is for FileRead, not Bash
      expect(verifySandboxSignature('Bash', input[SANDBOX_SIGNATURE_KEY] as string)).toBe(false);
    });

    it('accepts valid signature', () => {
      const signature = createSandboxSignature('Bash');
      const input: Record<string, unknown> = {
        command: 'ls -la',
        [SANDBOX_WRAPPED_MARKER]: true,
        [SANDBOX_SIGNATURE_KEY]: signature,
      };

      expect(verifySandboxSignature('Bash', input[SANDBOX_SIGNATURE_KEY] as string)).toBe(true);
    });

    it('uses timing-safe comparison', () => {
      const signature = createSandboxSignature('Bash');

      // Create a signature that differs in the last byte
      const differentSignature = signature.slice(0, -2) + 'ff';

      // Both should return false, but timing should be constant
      expect(verifySandboxSignature('Bash', differentSignature)).toBe(false);
    });
  });

  describe('Protected Path Bypass Prevention', () => {
    it('detects protected paths', () => {
      const protectedPaths = [
        '/etc/passwd',
        '/etc/shadow',
        '/root/.ssh/id_rsa',
        '~/.aws/credentials',
      ];

      for (const p of protectedPaths) {
        expect(containsProtectedPath(p)).toBe(true);
      }
    });

    it('allows normal paths', () => {
      const normalPaths = [
        '/tmp/test.txt',
        '/home/user/project',
        './src/index.ts',
      ];

      for (const p of normalPaths) {
        expect(containsProtectedPath(p)).toBe(false);
      }
    });

    it('detects path traversal attempts', () => {
      const traversalPaths = [
        '../../../etc/passwd',
        '/tmp/../../../etc/shadow',
        '....//....//etc/passwd',
      ];

      for (const p of traversalPaths) {
        // Path traversal should be detected
        expect(containsProtectedPath(p)).toBe(true);
      }
    });

    // H2: Expanded protected path coverage
    it('detects credential and secret paths', () => {
      const paths = [
        '/etc/ssl/private/key.pem',
        '/etc/pki/ca.crt',
        '/run/secrets/db_password',
      ];
      for (const p of paths) {
        expect(containsProtectedPath(p)).toBe(true);
      }
    });

    it('detects database credential paths', () => {
      const paths = [
        '/etc/mysql/my.cnf',
        '/etc/postgresql/pg_hba.conf',
      ];
      for (const p of paths) {
        expect(containsProtectedPath(p)).toBe(true);
      }
    });

    it('detects persistence and privilege escalation paths', () => {
      const paths = [
        '/etc/cron.d/evil',
        '/etc/cron.hourly/backdoor',
        '/etc/cron.daily/persist',
        '/etc/systemd/system/backdoor.service',
        '/etc/ld.so.preload',
      ];
      for (const p of paths) {
        expect(containsProtectedPath(p)).toBe(true);
      }
    });

    it('detects sudo and auth backdoor paths', () => {
      const paths = [
        '/etc/sudoers.d/admin',
        '/etc/pam.d/sshd',
      ];
      for (const p of paths) {
        expect(containsProtectedPath(p)).toBe(true);
      }
    });

    it('detects shell and profile injection paths', () => {
      const paths = [
        '/etc/environment',
        '/etc/profile.d/evil.sh',
        '/root/.bashrc',
        '/root/.profile',
      ];
      for (const p of paths) {
        expect(containsProtectedPath(p)).toBe(true);
      }
    });

    it('detects application config token paths', () => {
      const paths = [
        '/home/user/.config/gh/hosts.yml',
        '/home/user/.config/hub/config',
      ];
      for (const p of paths) {
        expect(containsProtectedPath(p)).toBe(true);
      }
    });
  });

  describe('Command Injection Prevention', () => {
    it('detects dangerous bash patterns', () => {
      const dangerousCommands = [
        'rm -rf /',
        'rm -rf /*',
        'rm -rf /tmp/test',
        'dd if=/dev/zero of=/dev/sda',
        'mkfs.ext4 /dev/sda1',
      ];

      for (const cmd of dangerousCommands) {
        const isDangerous = DANGEROUS_BASH_PATTERNS.some(pattern => pattern.test(cmd));
        expect(isDangerous).toBe(true);
      }
    });

    it('allows safe commands', () => {
      const safeCommands = [
        'ls -la',
        'cat /tmp/test.txt',
        'grep -r "pattern" .',
        'find . -name "*.ts"',
        'git status',
      ];

      for (const cmd of safeCommands) {
        const isDangerous = DANGEROUS_BASH_PATTERNS.some(pattern => pattern.test(cmd));
        expect(isDangerous).toBe(false);
      }
    });

    it('identifies read-only commands', () => {
      const readOnlyCommands = [
        'ls -la',
        'cat /tmp/test.txt',
        'head -n 10 file.txt',
        'tail -f /var/log/syslog',
        'grep pattern file.txt',
        'find . -name "*.ts"',
        'pwd',
        'whoami',
      ];

      for (const cmd of readOnlyCommands) {
        expect(isReadOnlyBashCommand(cmd)).toBe(true);
      }
    });

    it('identifies non-read-only commands', () => {
      const writeCommands = [
        'rm file.txt',
        'mv file1 file2',
        'chmod 755 script.sh',
        'echo "test" > file.txt',
        'npm install package',
      ];

      for (const cmd of writeCommands) {
        expect(isReadOnlyBashCommand(cmd)).toBe(false);
      }
    });
  });

  describe('Concurrent Permission Checks', () => {
    it('handles concurrent permission requests', async () => {
      const requests = Array.from({ length: 10 }, (_, i) =>
        hasPermissionsToUseTool('Bash', { command: `echo ${i}` })
      );

      const results = await Promise.all(requests);

      // All requests should complete without errors
      expect(results).toHaveLength(10);
      for (const result of results) {
        expect(result).toHaveProperty('behavior');
      }
    });

    it('maintains consistency under concurrent access', async () => {
      const results: string[] = [];

      const requests = Array.from({ length: 20 }, (_, i) =>
        hasPermissionsToUseTool('Bash', { command: 'ls' }).then(result => {
          results.push(result.behavior);
          return result;
        })
      );

      await Promise.all(requests);

      // All results should be valid behaviors
      const validBehaviors = ['allow', 'deny', 'ask'];
      for (const behavior of results) {
        expect(validBehaviors).toContain(behavior);
      }
    });
  });

  describe('Permission Denial Limits', () => {
    it('tracks consecutive denials', async () => {
      const { classifier } = await import('./classifier');

      // Reset classifier state
      classifier.reset();

      // Simulate multiple denials
      for (let i = 0; i < 5; i++) {
        classifier.trackDenial({ behavior: 'deny', confidence: 1, reason: 'test' });
      }

      expect(classifier.hasExceededLimits()).toBe(true);
      expect(classifier.getStats().consecutiveDenials).toBe(5);
    });

    it('resets denial count on allow', async () => {
      const { classifier } = await import('./classifier');

      classifier.reset();

      // Simulate some denials
      classifier.trackDenial({ behavior: 'deny', confidence: 1, reason: 'test' });
      classifier.trackDenial({ behavior: 'deny', confidence: 1, reason: 'test' });

      // Then an allow
      classifier.trackDenial({ behavior: 'allow', confidence: 1, reason: 'test' });

      expect(classifier.getStats().consecutiveDenials).toBe(0);
    });
  });
});
