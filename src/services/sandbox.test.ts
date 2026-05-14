import { describe, it, expect } from 'vitest';
import { SandboxManager } from './sandbox';
import { BubblewrapSandbox, SeccompSandbox, NoopSandbox } from './sandbox-profiles';
import type { SandboxOptions } from './sandbox';
import {
  DEFAULT_SANDBOX_POLICY,
  getToolPolicy,
  shouldSandbox,
  mergeSandboxPolicy,
  matchPattern,
} from './sandbox-policy';
import type { SandboxPolicy, SandboxEnforcementLevel } from './sandbox-policy';

const baseOptions: SandboxOptions = {
  enabled: true,
  backend: 'bubblewrap',
  workDir: '/workspace',
  allowNetwork: false,
  maxMemoryMb: 512,
  cpuTimeLimitSec: 60,
};

describe('BubblewrapSandbox', () => {
  const sandbox = new BubblewrapSandbox();

  it('has name "bubblewrap"', () => {
    expect(sandbox.name).toBe('bubblewrap');
  });

  it('wraps command with bwrap args', () => {
    const wrapped = sandbox.wrapCommand('ls -la', baseOptions);
    expect(wrapped).toContain('bwrap');
    expect(wrapped).toContain('--unshare-pid');
    expect(wrapped).toContain('--unshare-net');
    expect(wrapped).toContain('--die-with-parent');
    expect(wrapped).toContain('--bind /workspace /workspace');
    expect(wrapped).toContain('--ro-bind /usr /usr');
  });

  it('skips --unshare-net when allowNetwork is true', () => {
    const wrapped = sandbox.wrapCommand('curl http://example.com', { ...baseOptions, allowNetwork: true });
    expect(wrapped).not.toContain('--unshare-net');
  });

  it('includes resource limits (rlimit or fallback)', () => {
    const wrapped = sandbox.wrapCommand('ls', baseOptions);
    // bwrap >= 0.10 supports --rlimit-*, older versions fall back to ulimit
    // (CPU time limit is enforced by ToolExecutor.executeWithTimeout, not nested timeout)
    const hasRlimitNative = wrapped.includes('--rlimit-as');
    const hasRlimitFallback = wrapped.includes('ulimit -v');
    expect(hasRlimitNative || hasRlimitFallback).toBe(true);
  });

  it('escapes single quotes in commands', () => {
    const wrapped = sandbox.wrapCommand("echo 'hello world'", baseOptions);
    expect(wrapped).toContain("'\\''");
  });
});

describe('SeccompSandbox', () => {
  const sandbox = new SeccompSandbox();

  it('has name "seccomp"', () => {
    expect(sandbox.name).toBe('seccomp');
  });

  it('includes ulimit for memory', () => {
    const wrapped = sandbox.wrapCommand('ls -la', baseOptions);
    expect(wrapped).toContain('ulimit -v');
    expect(wrapped).toContain('524288');
  });

  it('includes timeout', () => {
    const wrapped = sandbox.wrapCommand('ls -la', baseOptions);
    expect(wrapped).toContain('timeout --signal=KILL 60');
  });

  it('omits ulimit when maxMemoryMb is 0', () => {
    const wrapped = sandbox.wrapCommand('ls', { ...baseOptions, maxMemoryMb: 0 });
    expect(wrapped).not.toContain('ulimit');
  });
});

describe('NoopSandbox', () => {
  const sandbox = new NoopSandbox();

  it('has name "noop"', () => {
    expect(sandbox.name).toBe('noop');
  });

  it('is always available', () => {
    expect(sandbox.isAvailable()).toBe(true);
  });

  it('passes commands through unchanged', () => {
    expect(sandbox.wrapCommand('ls -la', baseOptions)).toBe('ls -la');
  });
});

describe('SandboxManager', () => {
  it('uses noop when disabled', () => {
    const manager = new SandboxManager({ enabled: false, workDir: '/workspace' });
    expect(manager.getBackendName()).toBe('noop');
  });

  it('passes through when disabled', () => {
    const manager = new SandboxManager({ enabled: false, workDir: '/workspace' });
    expect(manager.wrapCommand('echo test')).toBe('echo test');
  });

  it('uses requested noop backend', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'noop', workDir: '/workspace' });
    expect(manager.getBackendName()).toBe('noop');
  });

  it('falls back through backend chain', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'bubblewrap', workDir: '/workspace' });
    expect(['bubblewrap', 'seccomp', 'noop']).toContain(manager.getBackendName());
  });

  it('wrapCommand returns a string', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'noop', workDir: '/workspace' });
    expect(typeof manager.wrapCommand('echo test')).toBe('string');
  });

  it('respects per-tool policy for excluded tools', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'noop', workDir: '/workspace' });
    // FileRead is excluded by default policy
    expect(manager.shouldSandboxTool('FileRead')).toBe('run-unsandboxed');
  });

  it('respects per-tool policy for required tools', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'noop', workDir: '/workspace' });
    // Bash requires sandbox, but noop is available (not a real sandbox)
    // In noop mode, required tools should be denied
    expect(manager.shouldSandboxTool('Bash')).toBe('deny');
  });

  it('returns policy for a specific tool', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'noop', workDir: '/workspace' });
    const policy = manager.getToolSandboxPolicy('Bash');
    expect(policy.enforcement).toBe('required');
    expect(policy.allowNetwork).toBe(false);
  });

  it('returns the active policy', () => {
    const manager = new SandboxManager({ enabled: true, backend: 'noop', workDir: '/workspace' });
    const policy = manager.getPolicy();
    expect(policy.enabled).toBe(true);
    expect(policy.defaultEnforcement).toBe('preferred');
  });
});

describe('sandbox-policy', () => {
  describe('DEFAULT_SANDBOX_POLICY', () => {
    it('has sensible defaults', () => {
      expect(DEFAULT_SANDBOX_POLICY.enabled).toBe(true);
      expect(DEFAULT_SANDBOX_POLICY.backend).toBe('bubblewrap');
      expect(DEFAULT_SANDBOX_POLICY.defaultEnforcement).toBe('preferred');
      expect(DEFAULT_SANDBOX_POLICY.allowNetwork).toBe(false);
      expect(DEFAULT_SANDBOX_POLICY.maxMemoryMb).toBe(512);
      expect(DEFAULT_SANDBOX_POLICY.cpuTimeLimitSec).toBe(60);
    });

    it('has default tool policies for known tools', () => {
      expect(DEFAULT_SANDBOX_POLICY.toolPolicies['Bash'].enforcement).toBe('required');
      expect(DEFAULT_SANDBOX_POLICY.toolPolicies['FileRead'].enforcement).toBe('excluded');
      expect(DEFAULT_SANDBOX_POLICY.toolPolicies['WebFetch'].allowNetwork).toBe(true);
    });

    it('has default pattern rules', () => {
      expect(DEFAULT_SANDBOX_POLICY.patternRules.length).toBeGreaterThan(0);
      expect(DEFAULT_SANDBOX_POLICY.patternRules[0].pattern).toBe('Task*');
    });
  });

  describe('getToolPolicy', () => {
    it('returns exact match for known tools', () => {
      const policy = getToolPolicy('Bash');
      expect(policy.enforcement).toBe('required');
    });

    it('returns pattern match for unmatched tools', () => {
      const policy = getToolPolicy('TaskCreate');
      expect(policy.enforcement).toBe('excluded');
    });

    it('returns default enforcement for unknown tools', () => {
      const policy = getToolPolicy('SomeUnknownTool');
      expect(policy.enforcement).toBe('preferred');
    });

    it('uses custom policy overrides', () => {
      const customPolicy: SandboxPolicy = {
        ...DEFAULT_SANDBOX_POLICY,
        toolPolicies: {
          ...DEFAULT_SANDBOX_POLICY.toolPolicies,
          Bash: { enforcement: 'optional' as SandboxEnforcementLevel },
        },
      };
      const result = getToolPolicy('Bash', customPolicy);
      expect(result.enforcement).toBe('optional');
    });

    it('respects per-tool network override', () => {
      const policy = getToolPolicy('WebFetch');
      expect(policy.allowNetwork).toBe(true);
    });
  });

  describe('shouldSandbox', () => {
    it('returns run-unsandboxed when policy disabled', () => {
      const disabledPolicy: SandboxPolicy = {
        ...DEFAULT_SANDBOX_POLICY,
        enabled: false,
      };
      expect(shouldSandbox('Bash', true, disabledPolicy)).toBe('run-unsandboxed');
    });

    it('returns deny when required but sandbox unavailable', () => {
      expect(shouldSandbox('Bash', false)).toBe('deny');
    });

    it('returns run-sandboxed when required and available', () => {
      expect(shouldSandbox('Bash', true)).toBe('run-sandboxed');
    });

    it('returns run-unsandboxed for excluded tools', () => {
      expect(shouldSandbox('FileRead', true)).toBe('run-unsandboxed');
    });

    it('returns run-unsandboxed for preferred when unavailable', () => {
      expect(shouldSandbox('FileWrite', false)).toBe('run-unsandboxed');
    });
  });

  describe('mergeSandboxPolicy', () => {
    it('returns default policy when no input', () => {
      const result = mergeSandboxPolicy();
      expect(result.enabled).toBe(true);
      expect(result.backend).toBe('bubblewrap');
    });

    it('merges user overrides with defaults', () => {
      const result = mergeSandboxPolicy({
        enabled: false,
        backend: 'docker',
        allowNetwork: true,
      });
      expect(result.enabled).toBe(false);
      expect(result.backend).toBe('docker');
      expect(result.allowNetwork).toBe(true);
      expect(result.defaultEnforcement).toBe('preferred'); // default preserved
    });

    it('merges toolPolicies without replacing defaults', () => {
      const result = mergeSandboxPolicy({
        toolPolicies: {
          CustomTool: { enforcement: 'required' as SandboxEnforcementLevel },
        },
      });
      expect(result.toolPolicies['CustomTool'].enforcement).toBe('required');
      expect(result.toolPolicies['Bash'].enforcement).toBe('required'); // default preserved
    });

    it('appends pattern rules to defaults', () => {
      const result = mergeSandboxPolicy({
        patternRules: [
          { pattern: 'Custom*', policy: { enforcement: 'optional' as SandboxEnforcementLevel } },
        ],
      });
      // Default rules + custom rule
      expect(result.patternRules.length).toBe(DEFAULT_SANDBOX_POLICY.patternRules.length + 1);
    });
  });

  describe('matchPattern', () => {
    it('matches exact strings', () => {
      expect(matchPattern('Bash', 'Bash')).toBe(true);
    });

    it('matches wildcard at end', () => {
      expect(matchPattern('Task*', 'TaskCreate')).toBe(true);
      expect(matchPattern('Task*', 'TaskGet')).toBe(true);
    });

    it('matches wildcard at start', () => {
      expect(matchPattern('*Tool', 'BashTool')).toBe(true);
    });

    it('does not match non-matching patterns', () => {
      expect(matchPattern('Task*', 'FileRead')).toBe(false);
      expect(matchPattern('File*', 'Bash')).toBe(false);
    });
  });
});
