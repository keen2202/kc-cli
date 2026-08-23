// Unit tests for the shared pure command-execution helpers (audit round3 T19).
//
// These drive the REAL implementations end-to-end: real HMAC signature
// creation/verification via the executor's exported helpers, real
// dangerous-command patterns, real Windows-compat detection. No module mocks.
// The sandbox stub below is a plain fixture implementing SandboxManagerLike
// (the MockShell-style injection seam), not a vi.mock'd security module.

import { describe, it, expect } from 'vitest';
import {
  applySandboxPreWrap,
  checkDangerousCommand,
  guardsWindowsFind,
  handleNonZeroExit,
} from './command-execution';
import {
  SANDBOX_WRAPPED_MARKER,
  SANDBOX_SIGNATURE_KEY,
  createSandboxSignature,
} from '../../executors/toolExecutor';
import type { SandboxManagerLike } from '../protocol';

/** Recording SandboxManagerLike fixture (injection seam for pure testing). */
function makeSandbox(overrides: Partial<SandboxManagerLike> = {}) {
  const wrapped: Array<[string, string | undefined]> = [];
  const sandbox: SandboxManagerLike = {
    isAvailable: () => true,
    wrapCommand: (command, toolName) => {
      wrapped.push([command, toolName]);
      return `wrapped(${command})`;
    },
    getBackendName: () => 'docker',
    shouldSandboxTool: () => 'run-sandboxed',
    ...overrides,
  };
  return { sandbox, wrapped };
}

describe('guardsWindowsFind', () => {
  it('blocks Unix find syntax on win32 with the fail-fast message both tools emit', () => {
    const guard = guardsWindowsFind('find . -name "*.ts"', 'win32');
    expect(guard.blocked).toBe(true);
    expect(guard.errorMessage).toMatch(
      /^\[tool_execution_failed\] Command not executed: Unix 'find' is not available on Windows/
    );
  });

  it('does not block on non-Windows platforms', () => {
    const linux = guardsWindowsFind('find . -name "*.ts"', 'linux');
    const darwin = guardsWindowsFind('find . -name "*.ts"', 'darwin');
    expect(linux.blocked).toBe(false);
    expect(linux.errorMessage).toBeUndefined();
    expect(darwin.blocked).toBe(false);
  });

  it('does not block FIND.EXE text-search usage on win32', () => {
    expect(guardsWindowsFind('find "pattern" file.txt', 'win32').blocked).toBe(false);
  });
});

describe('applySandboxPreWrap', () => {
  it('uses a validly-signed executor pre-wrap as-is without double-wrapping', () => {
    const { sandbox, wrapped } = makeSandbox();
    const input = {
      command: 'ls -la',
      [SANDBOX_WRAPPED_MARKER]: true,
      [SANDBOX_SIGNATURE_KEY]: createSandboxSignature('Run'),
    };
    const outcome = applySandboxPreWrap({
      command: 'ls -la',
      toolName: 'Run',
      input,
      sandbox,
    });
    expect(outcome.wrappedCmd).toBe('ls -la');
    expect(wrapped).toHaveLength(0); // verified pre-wrap short-circuits wrapCommand
    expect(outcome.sandboxed).toBe(true);
    expect(outcome.sandboxBackend).toBe('docker');
  });

  it('rejects a forged signature scoped to another tool and wraps fresh instead', () => {
    const { sandbox, wrapped } = makeSandbox();
    const input = {
      command: 'echo hi',
      [SANDBOX_WRAPPED_MARKER]: true,
      [SANDBOX_SIGNATURE_KEY]: createSandboxSignature('Bash'), // wrong scope for 'Run'
    };
    const outcome = applySandboxPreWrap({
      command: 'echo hi',
      toolName: 'Run',
      input,
      sandbox,
    });
    expect(wrapped).toEqual([['echo hi', 'Run']]);
    expect(outcome.wrappedCmd).toBe('wrapped(echo hi)');
    expect(outcome.sandboxed).toBe(true);
  });

  it('passes commands through unsandboxed when no manager exists and input is unwrapped', () => {
    const outcome = applySandboxPreWrap({
      command: 'echo hi',
      toolName: 'Bash',
      input: { command: 'echo hi' },
    });
    expect(outcome).toEqual({ wrappedCmd: 'echo hi', sandboxed: false, sandboxBackend: undefined });
  });

  it('throws the per-tool denial message when fallback wrapping is denied', () => {
    const denied = makeSandbox({
      wrapCommand: () => {
        throw new Error('sandbox policy denial');
      },
    }).sandbox;
    const observed: unknown[] = [];
    expect(() =>
      applySandboxPreWrap({
        command: 'echo hi',
        toolName: 'Run',
        input: {},
        sandbox: denied,
        onWrapError: (error) => observed.push(error),
      })
    ).toThrow('Run tool requires sandbox but sandbox is not available');
    // RunTool observes the suppressed error via its logger callback;
    // BashTool omits the callback and stays silent.
    expect(observed).toHaveLength(1);
    expect((observed[0] as Error).message).toBe('sandbox policy denial');
  });

  it('throws silently when no onWrapError observer is provided (BashTool path)', () => {
    const denied = makeSandbox({
      wrapCommand: () => {
        throw new Error('sandbox policy denial');
      },
    }).sandbox;
    expect(() =>
      applySandboxPreWrap({
        command: 'echo hi',
        toolName: 'Bash',
        input: {},
        sandbox: denied,
      })
    ).toThrow('Bash tool requires sandbox but sandbox is not available');
  });
});

describe('handleNonZeroExit', () => {
  it('formats the exact failure message shared by both tools', () => {
    const failure = handleNonZeroExit({
      exitCode: 2,
      command: 'make',
      scanText: 'error',
      detail: 'boom',
      platform: 'linux',
    });
    expect(failure.message).toBe('Command failed (exit 2): boom');
    expect(failure.winHint).toBeNull();
  });

  it('appends the Windows replacement hint on cmd.exe not-found output', () => {
    const detail = "'grep' is not recognized as an internal or external command";
    const failure = handleNonZeroExit({
      exitCode: 1,
      command: 'grep pattern file.txt',
      scanText: detail,
      detail,
      platform: 'win32',
    });
    expect(failure.winHint).toContain("Hint: 'grep' is a Unix command");
    expect(failure.message).toBe(`Command failed (exit 1): ${detail}\n${failure.winHint}`);
  });

  it('adds no hint for ordinary failures even on win32', () => {
    const failure = handleNonZeroExit({
      exitCode: 1,
      command: 'grep pattern file.txt',
      scanText: 'No such file or directory',
      detail: 'No such file or directory',
      platform: 'win32',
    });
    expect(failure.winHint).toBeNull();
    expect(failure.message).toBe('Command failed (exit 1): No such file or directory');
  });
});

describe('checkDangerousCommand', () => {
  it('flags destructive commands through the shared deny path', () => {
    const verdict = checkDangerousCommand('rm -rf /');
    expect(verdict.dangerous).toBe(true);
    expect(verdict.classifiedCommand).toBe('rm -rf /');
  });

  it('trims before classification (RunTool raw-trim path)', () => {
    const verdict = checkDangerousCommand('  rm -rf /tmp/x  ');
    expect(verdict.dangerous).toBe(true);
    expect(verdict.classifiedCommand).toBe('rm -rf /tmp/x');
  });

  it('normalizes obfuscation only when asked, changing the classified string (BashTool path)', () => {
    const obfuscated = 'r\\m -rf /'; // shell-escape bypass vector
    // The classifier self-normalizes internally, so the verdict matches either way…
    expect(checkDangerousCommand(obfuscated).dangerous).toBe(true);
    expect(checkDangerousCommand(obfuscated).classifiedCommand).toBe('r\\m -rf /');
    // …but only { normalize: true } produces the canonical string that BashTool
    // reports in deny messages and feeds to read-only matching.
    const normalized = checkDangerousCommand(obfuscated, { normalize: true });
    expect(normalized.dangerous).toBe(true);
    expect(normalized.classifiedCommand).toBe('rm -rf /');
  });

  it('leaves benign commands alone', () => {
    const verdict = checkDangerousCommand('mkdir testdir', { normalize: true });
    expect(verdict.dangerous).toBe(false);
    expect(verdict.classifiedCommand).toBe('mkdir testdir');
  });
});
