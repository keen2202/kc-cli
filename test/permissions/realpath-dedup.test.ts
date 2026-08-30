// T24 (P2, decision D3): realpath resolution is deduped *within* a single
// permission check — per-call Map, zero cross-call staleness — round4 §5-P3
//
// The REAL permission engine runs; only node's `realpathSync` is wrapped with
// a counting pass-through (fs is plain IO, not a security module — the
// AGENTS.md mock ban targets the security modules themselves).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { realpathSync } from 'fs';
import { hasPermissionsToUseTool } from '../../src/permissions/engine';
import { initializeState } from '../../src/bootstrap/state';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    realpathSync: vi.fn(actual.realpathSync),
  };
});

beforeEach(() => {
  (realpathSync as unknown as ReturnType<typeof vi.fn>).mockClear();
  initializeState({
    cwd: '/tmp',
    projectRoot: null,
    sessionId: 't24',
    permissionMode: 'default',
    verbose: false,
    printMode: false,
    bareMode: false,
    maxTurns: null,
    maxBudgetUsd: null,
    config: null,
  });
});

/** Input whose nested object repeats the same path-like string. */
function inputWithRepeatedPath(path: string): Record<string, unknown> {
  return {
    file_path: path,
    alternate_target: path,
    nested: { also_the_same: path, list: [path, path] },
  };
}

function callsFor(path: string): number {
  return (realpathSync as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
    ([p]) => p === path,
  ).length;
}

describe('T24: realpath dedup in the permission hot path', () => {
  it('resolves the same path once per check (count = 1)', async () => {
    const input = inputWithRepeatedPath('/tmp/some/target.ts');

    await hasPermissionsToUseTool('FileWrite', input, {
      content: undefined,
      config: undefined,
    } as never);

    expect(callsFor('/tmp/some/target.ts')).toBe(1);
  });

  it('a fresh check re-resolves: the per-call map is not shared across calls', async () => {
    const input = inputWithRepeatedPath('/tmp/some/other.ts');
    const options = { content: undefined, config: undefined } as never;

    await hasPermissionsToUseTool('FileWrite', input, options);
    expect(callsFor('/tmp/some/other.ts')).toBe(1);

    await hasPermissionsToUseTool('FileWrite', input, options);
    // Exactly one more call: no cache reuse across checks (zero staleness).
    expect(callsFor('/tmp/some/other.ts')).toBe(2);
  });

  it('non-path values never hit realpath (unchanged fast path)', async () => {
    await hasPermissionsToUseTool('Bash', { command: 'echo not-a-path-at-all' }, {
      content: undefined,
      config: undefined,
    } as never);

    expect((realpathSync as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
