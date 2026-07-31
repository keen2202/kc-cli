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
 * The verification gate lives in QueryEngineVerification.ts as exported pure
 * functions (extracted from QueryEngine); they are the security contract under
 * test and are imported directly here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  isStaticCommandSafe,
  resolveTypeCheckCommand,
  verifyTypeCheckBeforeExit,
} from '../../src/query/QueryEngineVerification';
import type { PatchGuaranteeConfig } from '../../src/query/protocol';
import { initializeState, updateState } from '../../src/bootstrap/state';

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
    expect(isStaticCommandSafe('npx tsc --noEmit')).toBe(true);
    expect(isStaticCommandSafe('tsc')).toBe(true);
    expect(isStaticCommandSafe('npm run typecheck')).toBe(true);
    expect(isStaticCommandSafe('npm run type-check')).toBe(true);
    expect(isStaticCommandSafe('python -m mypy')).toBe(true);
    expect(isStaticCommandSafe('cargo check')).toBe(true);
  });

  it('rejects shell metacharacters that enable chaining/injection', () => {
    expect(isStaticCommandSafe('npx tsc && rm -rf /')).toBe(false); // &
    expect(isStaticCommandSafe('tsc; echo pwned')).toBe(false); // ;
    expect(isStaticCommandSafe('tsc | cat')).toBe(false); // |
    expect(isStaticCommandSafe('tsc `whoami`')).toBe(false); // backtick
    expect(isStaticCommandSafe('tsc $(id)')).toBe(false); // $()
    expect(isStaticCommandSafe('tsc > out.txt')).toBe(false); // redirect
  });

  it('rejects commands whose runner is not on the allowlist', () => {
    expect(isStaticCommandSafe('echo hacked')).toBe(false);
    expect(isStaticCommandSafe('node evil.js')).toBe(false);
    expect(isStaticCommandSafe('rm -rf build')).toBe(false);
  });
});

describe('T5: resolveTypeCheckCommand', () => {
  it('prefers an explicit config command and trims whitespace', () => {
    expect(
      resolveTypeCheckCommand(makePgConfig({ typeCheckCommand: '  npx tsc --noEmit  ' })),
    ).toBe('npx tsc --noEmit');
  });

  it('returns empty string when no command resolves (no project markers)', () => {
    updateState({ cwd: makeTempDir() }); // empty dir → no language detected
    expect(resolveTypeCheckCommand(makePgConfig())).toBe('');
  });
});

describe('T5: verifyTypeCheckBeforeExit classification', () => {
  it('returns typecheck_not_found (gives way) when no command resolves', async () => {
    updateState({ cwd: makeTempDir() });
    const result = await verifyTypeCheckBeforeExit(makePgConfig());
    expect(result.canExit).toBe(true);
    expect(result.reason).toBe('typecheck_not_found');
  });

  it('rejects an unsafe command as typecheck_not_found (never executed)', async () => {
    const result = await verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'tsc; echo pwned' }),
    );
    expect(result.canExit).toBe(true);
    expect(result.reason).toBe('typecheck_not_found');
  });

  it('runs the command on this platform and passes on exit 0 (cross-platform proof)', async () => {
    const result = await verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'npx tsc --version' }),
    );
    expect(result.reason).toBe('typecheck_pass');
    expect(result.canExit).toBe(true);
  }, 60000);

  it('blocks exit on non-zero exit and returns failure details', async () => {
    const result = await verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'npx tsc -p tsconfig.doesnotexist.json' }),
    );
    expect(result.reason).toBe('typecheck_fail');
    expect(result.canExit).toBe(false);
    expect(typeof result.failures).toBe('string');
    expect(result.failures.length).toBeGreaterThan(0);
  }, 60000);

  it('gives way on timeout without misreporting pass/fail', async () => {
    const result = await verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'npx tsc --noEmit', verificationTimeout: 0.1 }),
    );
    expect(result.reason).toBe('timeout');
    expect(result.canExit).toBe(true);
  }, 60000);

  it('gives way on spawn/infra failure by default (typecheck_infra_error)', async () => {
    // A non-existent cwd makes spawn emit ENOENT (an infrastructure failure),
    // distinct from a genuine type error.
    updateState({ cwd: path.join(os.tmpdir(), 'kc-nonexistent-' + Date.now()) });
    const result = await verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'tsc' }),
    );
    expect(result.reason).toBe('typecheck_infra_error');
    expect(result.canExit).toBe(true);
  });

  it('blocks exit on spawn/infra failure when typeCheckStrict is set', async () => {
    updateState({ cwd: path.join(os.tmpdir(), 'kc-nonexistent-' + Date.now()) });
    const result = await verifyTypeCheckBeforeExit(
      makePgConfig({ typeCheckCommand: 'tsc', typeCheckStrict: true }),
    );
    expect(result.reason).toBe('typecheck_infra_error');
    expect(result.canExit).toBe(false);
    expect(typeof result.failures).toBe('string');
    expect(result.failures.length).toBeGreaterThan(0);
  });
});
