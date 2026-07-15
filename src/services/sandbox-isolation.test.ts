// S2-specific tests: sandbox no-isolation warning + failIfNoSandbox
// Kept separate from sandbox.test.ts because it requires mocking the backend
// profiles (which the existing tests rely on being real).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from './logger';

// Force all real sandbox backends to be unavailable so resolveBackend falls back to noop.
// This makes the S2 tests deterministic regardless of the host OS (Windows/Linux/macOS).
vi.mock('./sandbox-profiles', () => {
  class FakeBubblewrap { name = 'bubblewrap'; isAvailable() { return false; } wrapCommand(c: string) { return c; } }
  class FakeSeccomp { name = 'seccomp'; isAvailable() { return false; } wrapCommand(c: string) { return c; } }
  class FakeNoop { name = 'noop'; isAvailable() { return true; } wrapCommand(c: string) { return c; } }
  return { BubblewrapSandbox: FakeBubblewrap, SeccompSandbox: FakeSeccomp, NoopSandbox: FakeNoop };
});

vi.mock('./sandbox-docker', () => ({
  DockerSandbox: class { name = 'docker'; isAvailable() { return false; } wrapCommand(c: string) { return c; } },
}));

vi.mock('./sandbox-windows', () => ({
  WindowsSandbox: class { name = 'windows-sandbox'; isAvailable() { return false; } wrapCommand(c: string) { return c; } },
}));

import { SandboxManager } from './sandbox';

describe('[S2] sandbox no-isolation warning + failIfNoSandbox', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-S2.1: warns NO ISOLATION when falling back to noop (failIfNoSandbox: false)', () => {
    const warn = vi.spyOn(logger.services, 'warn').mockImplementation(() => {});
    new SandboxManager({ workDir: '/tmp', enabled: true, backend: 'bubblewrap', failIfNoSandbox: false });
    expect(warn.mock.calls.some(c => /NO ISOLATION/.test(String(c[0])))).toBe(true);
    warn.mockRestore();
  });

  it('AC-S2.2: throws when failIfNoSandbox set and no backend', () => {
    expect(() =>
      new SandboxManager({ workDir: '/tmp', enabled: true, backend: 'bubblewrap', failIfNoSandbox: true }),
    ).toThrow(/no sandbox backend/i);
  });

  it('AC-S2.2: no throw when failIfNoSandbox but backend explicitly noop', () => {
    expect(() =>
      new SandboxManager({ workDir: '/tmp', enabled: true, backend: 'noop', failIfNoSandbox: true }),
    ).not.toThrow();
  });
});
