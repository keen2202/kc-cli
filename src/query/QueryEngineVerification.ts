// Pre-exit verification gate (Area 2 / B2 / B3 / T5 / T7)
// Extracted from QueryEngine to keep the facade lean. Owns the type-check and
// test verification commands run before the agent is allowed to exit, plus the
// mapping of gate outcomes to completion-report entries.
//
// NOTE: this module intentionally uses child_process directly instead of the
// ExecutionEnv Shell abstraction: the gate semantics (T5) must distinguish
// timeout (SIGTERM/killed) from spawn-infrastructure failure ('error' event),
// which the Shell.exec contract cannot express. Verification always runs on
// the host, never inside a tool sandbox.

import { spawn } from 'child_process';
import { getState } from '../bootstrap/state';
import { detectProjectLanguage } from '../utils/project-detect';
import { logger } from '../services/logger';
import type { ChatMessage, PatchGuaranteeConfig } from './protocol';
import type { VerificationGateReport } from './completion-report';

/**
 * Result of pre-exit test verification.
 */
export type VerificationResult = {
  canExit: boolean;
  reason: 'tests_pass' | 'tests_fail' | 'tests_not_found' | 'timeout';
  failures?: string[];
  output?: string;
};

/**
 * Result of pre-exit type-check (compile) verification.
 */
export type TypeCheckResult = {
  canExit: boolean;
  reason: 'typecheck_pass' | 'typecheck_fail' | 'typecheck_not_found' | 'timeout' | 'typecheck_infra_error';
  failures?: string;
  output?: string;
};

/**
 * Validate that a test command doesn't contain shell injection patterns.
 * Only allows known test runners with sanitized arguments.
 */
export function isTestCommandSafe(command: string): boolean {
  // Reject shell metacharacters that enable command chaining, I/O redirection,
  // or escape sequences (SEC-06)
  if (/[;&|`$(){}$\n\r<>\\]/.test(command.replace('{test_names}', ''))) {
    return false;
  }
  // Allow only known test runner prefixes
  const allowedRunners = ['pytest', 'vitest', 'npx vitest', 'go test', 'cargo test', 'jest', 'npx jest', 'python -m pytest'];
  const trimmed = command.trim();
  return allowedRunners.some(runner => trimmed.startsWith(runner));
}

/** Validate test names contain only safe characters (SEC-06). */
export function isValidTestName(name: string): boolean {
  return /^[a-zA-Z0-9_\-./:]+$/.test(name);
}

/**
 * Determine the type-check command: explicit config wins, otherwise
 * auto-detect from the project language. Empty string means "no command".
 */
export function resolveTypeCheckCommand(config: PatchGuaranteeConfig): string {
  const explicit = config.typeCheckCommand?.trim();
  if (explicit) return explicit;
  const langInfo = detectProjectLanguage(getState().cwd);
  return langInfo?.typeCheckCommand?.trim() || '';
}

/**
 * Validate a type-check/compile command against a runner allowlist and reject
 * shell metacharacters that enable command chaining or injection (SEC-06).
 */
export function isStaticCommandSafe(command: string): boolean {
  if (/[;&|`$(){}\n\r<>\\]/.test(command)) {
    return false;
  }
  const allowedRunners = [
    'npx tsc', 'tsc', 'npm run build', 'npm run typecheck', 'npm run type-check',
    'go build', 'cargo check', 'cargo build',
    'mvn compile', 'gradle compileJava', './gradlew compileJava',
    'python -m mypy', 'mypy', 'pyright', 'npx pyright',
  ];
  const trimmed = command.trim();
  return allowedRunners.some(runner => trimmed.startsWith(runner));
}

/**
 * Run the project's type-check/compile command before allowing exit.
 * Pass/fail is determined by process exit code (0 = pass), which is more
 * reliable than parsing tool output across languages.
 */
export async function verifyTypeCheckBeforeExit(
  config: PatchGuaranteeConfig
): Promise<TypeCheckResult> {
  const command = resolveTypeCheckCommand(config);
  if (!command) {
    return { canExit: true, reason: 'typecheck_not_found' };
  }

  if (!isStaticCommandSafe(command)) {
    logger.query.warn(`[QueryEngine] Unsafe type-check command rejected: ${command.slice(0, 100)}`);
    return { canExit: true, reason: 'typecheck_not_found' };
  }

  const cwd = getState().cwd;

  try {
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      timedOut: boolean;
    }>((resolve, reject) => {
      // T5 (H5): run the command through the platform's default shell
      // (Windows: cmd.exe, *nix: /bin/sh) instead of hard-coding `bash`, which
      // does not exist on Windows and made this gate a silent no-op there.
      // The command was validated by isStaticCommandSafe (runner allowlist +
      // shell-metacharacter rejection), so `shell: true` cannot be abused for
      // injection here.
      const child = spawn(command, {
        cwd,
        timeout: config.verificationTimeout * 1000,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        // The `timeout` option kills the child (SIGTERM) once exceeded; detect
        // that so a timeout is never misreported as a pass or a type error.
        if (child.killed || signal === 'SIGTERM') timedOut = true;
        resolve({ stdout, stderr, code, timedOut });
      });
      // spawn-infrastructure failure (shell/runner missing, ENOENT, …) is NOT a
      // type-check result — reject so it is classified distinctly below.
      child.on('error', reject);
    });

    if (result.timedOut) {
      // Verification could not complete in time — give way (don't block) but
      // mark it distinctly rather than pretending it passed.
      logger.query.warn(
        `[QueryEngine] Type-check verification timed out after ${config.verificationTimeout}s: ${command}`
      );
      return { canExit: true, reason: 'timeout' };
    }

    if (result.code === 0) {
      return { canExit: true, reason: 'typecheck_pass' };
    }

    // Non-zero exit — the command ran and reported type/compile errors.
    const output = (result.stdout + result.stderr).trim();
    return {
      canExit: false,
      reason: 'typecheck_fail',
      failures: output.slice(-1500) || `Type-check command exited with code ${result.code ?? 'unknown'}`,
      output,
    };
  } catch (error) {
    // T5 (H5): distinguish spawn-infrastructure failure from a genuine result.
    // A missing toolchain/shell must NOT be treated as a pass. By default we
    // warn and give way so a broken environment doesn't wedge the agent; with
    // `typeCheckStrict` the gap blocks exit so it stays visible.
    const message = error instanceof Error ? error.message : String(error);
    logger.query.warn(
      `[QueryEngine] Type-check verification could not run (infrastructure error): ${message}`
    );
    if (config.typeCheckStrict) {
      return {
        canExit: false,
        reason: 'typecheck_infra_error',
        failures: `Type-check could not be executed: ${message}`,
      };
    }
    return { canExit: true, reason: 'typecheck_infra_error' };
  }
}

/**
 * Run the FAIL_TO_PASS test command before allowing exit.
 */
export async function verifyBeforeExit(
  testNames: string[],
  config: PatchGuaranteeConfig
): Promise<VerificationResult> {
  if (!testNames.length) {
    return { canExit: true, reason: 'tests_not_found' };
  }

  // Validate test names independently to prevent injection (SEC-06)
  const invalidNames = testNames.filter(n => !isValidTestName(n));
  if (invalidNames.length > 0) {
    logger.query.warn(`[QueryEngine] Invalid test names rejected: ${invalidNames.join(', ')}`);
    return { canExit: true, reason: 'tests_not_found' };
  }

  const testList = testNames.join(' ');
  const command = config.testCommand.replace('{test_names}', testList);
  const cwd = getState().cwd;

  // Validate command to prevent shell injection
  if (!isTestCommandSafe(command)) {
    logger.query.warn(`[QueryEngine] Unsafe test command rejected: ${command.slice(0, 100)}`);
    return { canExit: true, reason: 'tests_not_found' };
  }

  try {
    const result = await new Promise<{ stdout: string; stderr: string; code: number }>(
      (resolve, reject) => {
        const child = spawn('bash', ['-c', command], {
          cwd,
          timeout: config.verificationTimeout * 1000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code: number) => resolve({ stdout, stderr, code: code ?? 1 }));
        child.on('error', reject);
      }
    );

    const output = result.stdout + result.stderr;

    // Parse test results (pytest format: "10 passed, 2 failed")
    const failedMatch = output.match(/(\d+) failed/);
    const passedMatch = output.match(/(\d+) passed/);
    const totalFailed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
    const totalPassed = passedMatch ? parseInt(passedMatch[1], 10) : 0;

    if (totalFailed === 0 && totalPassed > 0) {
      return { canExit: true, reason: 'tests_pass', output };
    }

    // Extract failure details (last 500 chars of each failure block)
    const failureBlocks = output.match(
      /FAILED[\s\S]*?={5,}[\s\S]*?(?=\n={5,}|\n_+ |$)/g
    );

    return {
      canExit: false,
      reason: 'tests_fail',
      failures: failureBlocks?.map(f => f.slice(0, 300)) || [output.slice(0, 500)],
      output,
    };
  } catch {
    // On infra failure (timeout, spawn error), don't block exit
    return { canExit: true, reason: 'timeout' };
  }
}

/**
 * Extract FAIL_TO_PASS test names from conversation or state.
 */
export function extractFailToPassTests(messages: readonly ChatMessage[]): string[] {
  // Check if tests were provided in state
  const state = getState() as unknown as { failToPass?: unknown };
  if (state.failToPass && Array.isArray(state.failToPass)) {
    return state.failToPass;
  }

  // Fall back to scanning conversation for test references
  for (const msg of messages) {
    const content = msg.content || '';
    const match = content.match(/FAIL_TO_PASS[:\s]+(.+)/i);
    if (match) {
      return match[1].split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

/**
 * T7 (M2): map a pre-exit type-check gate result to a report gate. `ran` is
 * true only when the gate produced a definitive pass/fail verdict; timeout,
 * infra failure and not-found are reported honestly as not-run.
 */
export function toTypeCheckGateReport(
  tc: TypeCheckResult,
  config: PatchGuaranteeConfig,
): VerificationGateReport {
  const command = resolveTypeCheckCommand(config) || null;
  switch (tc.reason) {
    case 'typecheck_pass':
      return { ran: true, command, result: 'pass' };
    case 'typecheck_fail':
      return { ran: true, command, result: 'fail', details: tc.failures };
    case 'timeout':
      return { ran: false, command, result: 'timeout' };
    case 'typecheck_infra_error':
      return { ran: false, command, result: 'infra_error', details: tc.failures };
    case 'typecheck_not_found':
    default:
      return { ran: false, command, result: 'not_found' };
  }
}

/** T7 (M2): map a pre-exit test gate result to a report gate. */
export function toTestGateReport(
  v: VerificationResult,
  config: PatchGuaranteeConfig,
): VerificationGateReport {
  const command = config.testCommand || null;
  switch (v.reason) {
    case 'tests_pass':
      return { ran: true, command, result: 'pass' };
    case 'tests_fail':
      return { ran: true, command, result: 'fail', details: (v.failures || []).join('\n\n') };
    case 'timeout':
      return { ran: false, command, result: 'timeout' };
    case 'tests_not_found':
    default:
      return { ran: false, command, result: 'not_found' };
  }
}
