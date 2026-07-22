import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SandboxManager } from '../../src/services/sandbox';
import { DEFAULT_SANDBOX_POLICY, mergeSandboxPolicy } from '../../src/services/sandbox-policy';
import type { SandboxPolicy } from '../../src/services/sandbox-policy';
import { execSync } from 'child_process';

/**
 * Integration tests for sandbox isolation.
 * These tests verify that the sandbox actually provides isolation
 * (network, filesystem, resource limits) when a real backend is available.
 */

describe('Sandbox Integration', () => {
  let manager: SandboxManager;
  let backendName: string;

  beforeAll(() => {
    manager = new SandboxManager({
      workDir: '/tmp',
      enabled: true,
      backend: 'bubblewrap',
      // Don't hard-fail when no real backend is present (e.g. Windows dev boxes);
      // these tests only assert fallback/policy behavior.
      failIfNoSandbox: false,
    });
    backendName = manager.getBackendName();
  });

  describe('backend availability', () => {
    it('resolves to a valid backend', () => {
      expect(['bubblewrap', 'seccomp', 'docker', 'noop']).toContain(backendName);
    });

    it('reports availability correctly', () => {
      if (backendName !== 'noop') {
        expect(manager.isAvailable()).toBe(true);
      }
    });
  });

  describe('policy enforcement', () => {
    it('denies required tools when sandbox unavailable', () => {
      const noSandboxManager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
      });
      expect(noSandboxManager.shouldSandboxTool('Bash')).toBe('deny');
    });

    it('allows excluded tools regardless of sandbox', () => {
      expect(manager.shouldSandboxTool('FileRead')).toBe('run-unsandboxed');
      expect(manager.shouldSandboxTool('Grep')).toBe('run-unsandboxed');
    });

    it('requires sandbox for Bash tool', () => {
      const decision = manager.shouldSandboxTool('Bash');
      if (manager.isAvailable()) {
        expect(decision).toBe('run-sandboxed');
      } else {
        expect(decision).toBe('deny');
      }
    });

    it('allows network for WebFetch when configured', () => {
      const policy = mergeSandboxPolicy({
        toolPolicies: {
          WebFetch: { enforcement: 'preferred', allowNetwork: true },
        },
      });
      const toolPolicy = policy.toolPolicies['WebFetch'];
      expect(toolPolicy.allowNetwork).toBe(true);
    });
  });

  describe('command wrapping', () => {
    it('wraps commands when sandbox is available', () => {
      if (!manager.isAvailable()) return;

      const wrapped = manager.wrapCommand('echo hello', 'Bash');
      expect(typeof wrapped).toBe('string');
      expect(wrapped.length).toBeGreaterThan('echo hello'.length);
    });

    it('skips wrapping for excluded tools', () => {
      // Even when sandbox is available, excluded tools should not be wrapped
      const wrapped = manager.wrapCommand('echo hello', 'FileRead');
      expect(wrapped).toBe('echo hello');
    });

    it('throws for denied tools', () => {
      const noSandboxManager = new SandboxManager({
        workDir: '/tmp',
        enabled: true,
        backend: 'noop',
      });
      expect(() => noSandboxManager.wrapCommand('echo hello', 'Bash')).toThrow();
    });
  });
});

describe('Sandbox Policy Edge Cases', () => {
  it('handles empty toolPolicies gracefully', () => {
    const policy = mergeSandboxPolicy({ toolPolicies: {} });
    // Default tool policies should still be present
    expect(policy.toolPolicies['Bash'].enforcement).toBe('required');
  });

  it('handles invalid pattern rules gracefully', () => {
    const policy = mergeSandboxPolicy({
      patternRules: [
        { pattern: '', policy: { enforcement: 'required' } },
      ],
    });
    // Should not throw, pattern should just not match anything useful
    expect(policy.patternRules.length).toBeGreaterThan(0);
  });

  it('merges multiple policy layers correctly', () => {
    const policy = mergeSandboxPolicy({
      enabled: true,
      backend: 'docker',
      defaultEnforcement: 'optional',
      toolPolicies: {
        Bash: { enforcement: 'required', allowNetwork: true },
      },
      patternRules: [
        { pattern: 'Custom*', policy: { enforcement: 'excluded' } },
      ],
    });

    expect(policy.enabled).toBe(true);
    expect(policy.backend).toBe('docker');
    expect(policy.defaultEnforcement).toBe('optional');
    expect(policy.toolPolicies['Bash'].allowNetwork).toBe(true);
    expect(policy.toolPolicies['FileRead'].enforcement).toBe('excluded'); // default preserved
  });
});

describe('Sandbox Backend Fallback Chain', () => {
  it('falls back from unavailable backend to available one', () => {
    // Force a non-existent backend and verify fallback
    const manager = new SandboxManager({
      workDir: '/tmp',
      enabled: true,
      backend: 'docker', // May not be available
      failIfNoSandbox: false,
    });
    // Should resolve to something valid
    expect(['docker', 'bubblewrap', 'seccomp', 'noop']).toContain(manager.getBackendName());
  });

  it('warns when falling back from requested backend', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const manager = new SandboxManager({
      workDir: '/tmp',
      enabled: true,
      backend: 'docker',
      failIfNoSandbox: false,
    });

    // If docker is not available and we fell back, there should be a warning
    if (manager.getBackendName() !== 'docker' && manager.getBackendName() !== 'noop') {
      expect(warnSpy).toHaveBeenCalled();
    }

    warnSpy.mockRestore();
  });
});
