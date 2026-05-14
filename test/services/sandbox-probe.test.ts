// Tests for SandboxProbe

import { describe, it, expect, vi } from 'vitest';
import { SandboxProbe } from '../../src/services/sandbox-probe';
import type { SandboxBackend, SandboxOptions } from '../../src/services/sandbox';

// Mock child_process to avoid actually running sandbox commands
vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';

const mockExecSync = vi.mocked(execSync);

function createMockBackend(name = 'test-sandbox'): SandboxBackend {
  return {
    name,
    isAvailable: () => true,
    wrapCommand: (cmd: string) => `sandbox-exec ${cmd}`,
  };
}

function createMockOptions(overrides: Partial<SandboxOptions> = {}): SandboxOptions {
  return {
    enabled: true,
    backend: 'bubblewrap',
    workDir: '/tmp/test',
    allowNetwork: false,
    maxMemoryMb: 512,
    cpuTimeLimitSec: 60,
    ...overrides,
  };
}

describe('SandboxProbe', () => {
  const probe = new SandboxProbe();

  describe('verifyIsolation', () => {
    it('should pass all tests when sandbox blocks everything', async () => {
      // All commands fail (blocked by sandbox)
      mockExecSync.mockImplementation(() => {
        throw new Error('Command blocked');
      });

      const result = await probe.verifyIsolation(createMockBackend(), createMockOptions());

      expect(result.overallPassed).toBe(true);
      expect(result.passed).toBe(result.total);
      expect(result.failures).toHaveLength(0);
    });

    it('should detect filesystem escape when cat /etc/shadow succeeds', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        // First call (filesystem) returns ESCAPED, rest throw
        if (callCount === 1) return 'root:$6$...:19000:0:99999:7:::\n';
        throw new Error('blocked');
      });

      const result = await probe.verifyIsolation(createMockBackend(), createMockOptions());

      const fsTest = result.results.find(r => r.name === 'filesystem-isolation');
      expect(fsTest?.passed).toBe(false);
      expect(result.overallPassed).toBe(false);
    });

    it('should skip network test when allowNetwork is true', async () => {
      mockExecSync.mockImplementation(() => { throw new Error('blocked'); });

      const result = await probe.verifyIsolation(
        createMockBackend(),
        createMockOptions({ allowNetwork: true })
      );

      const netTest = result.results.find(r => r.name === 'network-isolation');
      expect(netTest?.message).toContain('Skipped');
      expect(netTest?.passed).toBe(true);
    });

    it('should detect network escape when wget succeeds', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 2) return 'ESCAPED\n'; // network test
        throw new Error('blocked');
      });

      const result = await probe.verifyIsolation(createMockBackend(), createMockOptions());

      const netTest = result.results.find(r => r.name === 'network-isolation');
      expect(netTest?.passed).toBe(false);
    });

    it('should detect privilege escalation when sudo succeeds', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 4) return 'ESCAPED\n'; // privilege test
        throw new Error('blocked');
      });

      const result = await probe.verifyIsolation(createMockBackend(), createMockOptions());

      const privTest = result.results.find(r => r.name === 'privilege-escalation');
      expect(privTest?.passed).toBe(false);
    });

    it('should count passed and failed tests correctly', async () => {
      let callCount = 0;
      mockExecSync.mockImplementation(() => {
        callCount++;
        if (callCount === 1) throw new Error('blocked'); // fs: pass
        if (callCount === 2) return 'BLOCKED\n';         // net: pass
        if (callCount === 3) throw new Error('blocked'); // proc: pass
        if (callCount === 4) return 'ESCAPED\n';         // priv: fail
        throw new Error('blocked');
      });

      const result = await probe.verifyIsolation(createMockBackend(), createMockOptions());

      expect(result.passed).toBe(3);
      expect(result.total).toBe(4);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0].name).toBe('privilege-escalation');
    });

    it('should measure test duration', async () => {
      mockExecSync.mockImplementation(() => { throw new Error('blocked'); });

      const result = await probe.verifyIsolation(createMockBackend(), createMockOptions());

      for (const test of result.results) {
        expect(test.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });
});
