/**
 * T5 (H5): Cross-platform pre-exit type-check verification.
 *
 * Regression coverage for the fix that replaced the hard-coded
 * `spawn('bash', ['-c', command])` (a silent no-op on Windows, where bash is
 * absent) with `spawn(command, { shell: true })` and an explicit result
 * classifier:
 *   - exit 0                    → typecheck_pass  (canExit)
 *   - non-zero exit             → typecheck_fail  (blocks, returns failures)
 *   - timeout (SIGTERM)         → timeout         (gives way, not a pass/fail)
 *   - spawn/infra failure       → typecheck_infra_error
 *       · default               → gives way (canExit)
 *       · typeCheckStrict        → blocks (canExit false)
 *   - no/unsafe command         → typecheck_not_found (gives way)
 *
 * The private methods are exercised via `as any` — they are internal to the
 * exit gate and have no public surface, but their behaviour is the security
 * contract under test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { QueryEngine } from '../../src/query/QueryEngine';
import type { PatchGuaranteeConfig } from '../../src/query/protocol';
import { initializeState, updateState } from '../../src/bootstrap/state';

/** Build a QueryEngine that does not require a working sandbox (Windows CI). */
function makeEngine(): any {
  return new QueryEngine(
    {
      model: 'test-model',
      provider: 'anthropic',
      apiKey: 'test-key',
      maxTurns: 10,
      maxBudgetUsd: null,
      sandboxFailIfNoSandbox: false,
    },
    [],
  );
}

function makePgConfig(overrides: Partial<PatchGuaranteeConfig> = {}): PatchGuaranteeConfig {
  return {
    enabled: true,
    maxZeroPatchRetries: 3,
    maxVerificationRetries: 2,
    verificationTimeout: 60,
    testCommand: 'pytest {test_names} -x',
    typeCheck: true,
    typeCheckCommand: '',
    maxTypeCheckRetries: 2,
    typeCheckStrict: false,
    ...overrides,
  };
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-tc-'));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  // Default cwd = the real project root, so `npx tsc` resolves its local binary.
  initializeState();
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe('T5: isStaticCommandSafe (runner allowlist + injection guard)', () => {
  it('accepts allowlisted type-check runners', () => {
    const engine = makeEngine();
    expect(engine.isStaticCommandSafe('npx tsc --noEmit')).toBe(true);
    expect(engine.isStaticCommandSafe('tsc')).toBe(true);
    expect(engine.isStaticCommandSafe('npm run typecheck')).toBe(true);
    expect(engine.isStaticCommandSafe('npm run type-check')).toBe(true);
    expect(engine.isStaticCommandSafe('python -m mypy')).toBe(true);
    expect(engine.isStaticCommandSafe('cargo check')).toBe(true);
  });

  it('rejects shell metacharacters that enable chaining/injection', () => {
    const engine = makeEngine();
    expect(engine.isStaticCommandSafe('npx tsc && rm -rf /')).toBe(false); // &
    expect(engine.isStaticCommandSafe('tsc; echo pwned')).toBe(false); // ;
    expect(engine.isStaticCommandSafe('tsc | cat')).toBe(false); // |
    expect(engine.isStaticCommandSafe('tsc `whoami`')).toBe(false); // backtick
    expect(engine.isStaticCommandSafe('tsc $(id)')).toBe(false); // $()
    expect(engine.isStaticCommandSafe('tsc > out.txt')).toBe(false); // redirect
  });

  it('rejects commands whose runner is not on the allowlist', () => {
    const engine = makeEngine();
    expect(engine.isStaticCommandSafe('echo hacked')).toBe(false);
    expect(engine.isStaticCommandSafe('node evil.js')).toBe(false);
    expect(engine.isStaticCommandSafe('rm -rf build')).toBe(false);
  });
});

describe('T5: resolveTypeCheckCommand', () => {
  it('prefers an explicit config command and trims whitespace', () => {
    const engine = makeEngine();
    expect(
      engine.resolveTypeCheckCommand(makePgConfig({ typeCheckCommand: '  npx tsc --noEmit  ' })),
    ).toBe('npx tsc --noEmit');
  });

  it('returns empty string when no command resolves (no project markers)', () => {
    const engine = makeEngine();
    updateState({ cwd: makeTempDir() }); // empty dir → no language detected
    expect(engine.resolveTypeCheckCommand(makePgConfig())).toBe('');
  });
});

describe('T5: verifyTypeCheckBeforeExit classification', () => {
  it('returns typecheck_not_found (gives way) when no command resolves', async () => {
    const engine = makeEngine();
    updateState({ cwd: makeTempDir() });
    const result = await engine.verifyTypeCheckBeforeExit(makePgConfig());
    expect(result.canExit).toBe(true);
    expect(result.reason).toBe('typecheck_not_found');
  });

  it('rejects an unsafe command as typecheck_not_found (never executed)', async () => {
    const engine = makeEngine();
    const result = await engine.verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'tsc; echo pwned' }),
    );
    expect(result.canExit).toBe(true);
    expect(result.reason).toBe('typecheck_not_found');
  });

  it('runs the command on this platform and passes on exit 0 (cross-platform proof)', async () => {
    const engine = makeEngine();
    const result = await engine.verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'npx tsc --version' }),
    );
    expect(result.reason).toBe('typecheck_pass');
    expect(result.canExit).toBe(true);
  }, 60000);

  it('blocks exit on non-zero exit and returns failure details', async () => {
    const engine = makeEngine();
    const result = await engine.verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'npx tsc -p tsconfig.doesnotexist.json' }),
    );
    expect(result.reason).toBe('typecheck_fail');
    expect(result.canExit).toBe(false);
    expect(typeof result.failures).toBe('string');
    expect(result.failures.length).toBeGreaterThan(0);
  }, 60000);

  it('gives way on timeout without misreporting pass/fail', async () => {
    const engine = makeEngine();
    const result = await engine.verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'npx tsc --noEmit', verificationTimeout: 0.1 }),
    );
    expect(result.reason).toBe('timeout');
    expect(result.canExit).toBe(true);
  }, 60000);

  it('gives way on spawn/infra failure by default (typecheck_infra_error)', async () => {
    const engine = makeEngine();
    // A non-existent cwd makes spawn emit ENOENT (an infrastructure failure),
    // distinct from a genuine type error.
    updateState({ cwd: path.join(os.tmpdir(), 'kc-nonexistent-' + Date.now()) });
    const result = await engine.verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'tsc' }),
    );
    expect(result.reason).toBe('typecheck_infra_error');
    expect(result.canExit).toBe(true);
  });

  it('blocks exit on spawn/infra failure when typeCheckStrict is set', async () => {
    const engine = makeEngine();
    updateState({ cwd: path.join(os.tmpdir(), 'kc-nonexistent-' + Date.now()) });
    const result = await engine.verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'tsc', typeCheckStrict: true }),
    );
    expect(result.reason).toBe('typecheck_infra_error');
    expect(result.canExit).toBe(false);
    expect(typeof result.failures).toBe('string');
    expect(result.failures.length).toBeGreaterThan(0);
  });
});
