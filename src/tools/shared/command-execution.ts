// Shared pure helpers for command-executing tools (BashTool / RunTool).
//
// Extracted in audit remediation round 3 (T19 / spec §4-M8) from the
// near-identical blocks that previously lived duplicated in
// `BashTool/index.ts` (~45-141) and `RunTool/index.ts` (~39-128):
//
//   1. guardsWindowsFind    — pre-execution Windows `find` compatibility guard
//   2. applySandboxPreWrap  — executor sandbox pre-wrap detection + HMAC
//                             signature verification + fallback wrapping
//   3. handleNonZeroExit    — non-zero exit failure message formatting with
//                             Windows-native replacement hints
//   4. checkDangerousCommand— dangerous-command classification shared by both
//                             tools' checkPermissions implementations
//
// Purity contract: every function here is synchronous, performs no I/O, reads
// no globals — every environmental fact (platform, sandbox manager, raw tool
// input) is injected as a parameter. The tools pass `process.platform` /
// `context.sandbox` at their call sites, so observable behavior is unchanged
// from the pre-extraction inline implementations.

import { isDangerousBashCommand } from '../../permissions/readonlyCommands';
import { normalizeCommand } from '../../permissions/commandNormalizer';
import { isAlreadySandboxWrapped } from '../../executors/toolExecutor';
import type { SandboxManagerLike } from '../protocol';
import {
  detectUnixFindOnWindows,
  getWindowsCommandHint,
  isCommandNotFoundOutput,
} from '../BashTool/windows-compat';

// ─────────────────────────────────────────────────────────────────────────────
// 1. Windows `find` compatibility guard
// ─────────────────────────────────────────────────────────────────────────────

/** Result of the pre-execution Windows `find` guard. */
export type WindowsFindGuard =
  | { blocked: false; errorMessage?: undefined }
  | { blocked: true; errorMessage: string };

/**
 * Guard against Unix `find` syntax on Windows (previously duplicated at
 * BashTool/index.ts:45-54 and RunTool/index.ts:39-47).
 *
 * Unix `find` syntax resolves to FIND.EXE (a text-search tool) under cmd.exe
 * and fails with a cryptic parameter error. When the command would misbehave,
 * returns the exact fail-fast message both tools emit instead of executing:
 * `[tool_execution_failed] Command not executed: <diagnosis>`.
 *
 * @param command  Raw user command.
 * @param platform Injected platform (tools pass `process.platform`).
 */
export function guardsWindowsFind(command: string, platform: NodeJS.Platform): WindowsFindGuard {
  const findIncompat = detectUnixFindOnWindows(command, platform);
  if (findIncompat) {
    return {
      blocked: true,
      errorMessage: `[tool_execution_failed] Command not executed: ${findIncompat}`,
    };
  }
  return { blocked: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Sandbox pre-wrap + HMAC signature handling
// ─────────────────────────────────────────────────────────────────────────────

/** Command plus sandbox metadata resolved by {@link applySandboxPreWrap}. */
export interface SandboxPreWrapOutcome {
  /** Command to execute (executor pre-wrap used as-is, freshly wrapped otherwise). */
  wrappedCmd: string;
  sandboxed: boolean;
  sandboxBackend: string | undefined;
}

/**
 * Resolve the command to execute w.r.t. executor-level sandbox wrapping
 * (previously duplicated at BashTool/index.ts:56-81 and RunTool/index.ts:57-82).
 *
 * The ToolExecutor pre-wraps commands for 'Bash'/'Run' at the executor level
 * (the authoritative sandbox enforcement point). This helper first verifies
 * the executor's wrap marker + HMAC signature on the input
 * (`isAlreadySandboxWrapped`) and uses a verified pre-wrap as-is to avoid
 * double-wrapping; otherwise it falls back to wrapping via the injected
 * sandbox manager. With no manager and no valid pre-wrap the command passes
 * through unsandboxed — matching the original tools exactly.
 *
 * If fallback wrapping throws (sandbox denied), `onWrapError` (when provided)
 * observes the suppressed error, then an Error is thrown with the message
 * `<toolName> tool requires sandbox but sandbox is not available`.
 *
 * @param params.command     Raw user command.
 * @param params.toolName    Registered tool name ('Bash' | 'Run'); scopes the
 *                           HMAC check and appears in the denial message.
 * @param params.input       Raw tool input, scanned for marker + signature.
 * @param params.sandbox     Injected sandbox manager; may be undefined when
 *                           sandboxing is disabled.
 * @param params.onWrapError Optional observer for the suppressed wrap error
 *                           (RunTool logs it; BashTool ignores it).
 */
export function applySandboxPreWrap(params: {
  command: string;
  toolName: string;
  input: Record<string, unknown>;
  sandbox?: SandboxManagerLike;
  onWrapError?: (error: unknown) => void;
}): SandboxPreWrapOutcome {
  // Executor already wrapped the command — use it directly (signature verified)
  if (isAlreadySandboxWrapped(params.input, params.toolName)) {
    return {
      wrappedCmd: params.command,
      sandboxed: params.sandbox?.isAvailable() ?? false,
      sandboxBackend: params.sandbox?.getBackendName(),
    };
  }

  // Fallback: wrap via shared sandbox manager from ToolExecutor
  if (params.sandbox) {
    try {
      return {
        wrappedCmd: params.sandbox.wrapCommand(params.command, params.toolName),
        sandboxed: params.sandbox.isAvailable(),
        sandboxBackend: params.sandbox.getBackendName(),
      };
    } catch (error) {
      // Sandbox denied — this should have been caught by ToolExecutor already
      params.onWrapError?.(error);
      throw new Error(`${params.toolName} tool requires sandbox but sandbox is not available`);
    }
  }

  return { wrappedCmd: params.command, sandboxed: false, sandboxBackend: undefined };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Non-zero exit handling
// ─────────────────────────────────────────────────────────────────────────────

/** Formatted non-zero-exit failure produced by {@link handleNonZeroExit}. */
export interface NonZeroExitHandling {
  /**
   * Complete human-facing failure message:
   * `Command failed (exit <code>): <detail>` plus a `\n<hint>` suffix when the
   * scan text matches a "command not found" signature on Windows.
   */
  message: string;
  /** Windows replacement hint; null when not detected or not on win32. */
  winHint: string | null;
}

/**
 * Format a non-zero-exit failure, appending a Windows-native replacement hint
 * when the tool-specific scan text shows a "command not found" error
 * (previously duplicated at BashTool/index.ts:92-104 and RunTool/index.ts:91-100).
 *
 * The two tools legitimately differ in what they scan and embed — Bash scans
 * `` `${stderr}\n${stdout}` `` and details stderr (`|| 'non-zero exit code'`),
 * Run scans/details its trimmed `stdout || stderr` output and wraps the result
 * differently — so those stay tool-side as `scanText`/`detail` inputs; only the
 * shared hint detection + message formatting live here.
 *
 * @param params.exitCode Process exit code.
 * @param params.command  Raw command, used to pick the replacement hint.
 * @param params.scanText Output text scanned for not-found signatures.
 * @param params.detail   Tool-specific detail embedded after the exit prefix.
 * @param params.platform Injected platform (tools pass `process.platform`).
 */
export function handleNonZeroExit(params: {
  exitCode: number;
  command: string;
  scanText: string;
  detail: string;
  platform: NodeJS.Platform;
}): NonZeroExitHandling {
  const winHint = isCommandNotFoundOutput(params.scanText)
    ? getWindowsCommandHint(params.command, params.platform)
    : null;
  return {
    message: `Command failed (exit ${params.exitCode}): ${params.detail}${winHint ? `\n${winHint}` : ''}`,
    winHint,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Dangerous-command checking
// ─────────────────────────────────────────────────────────────────────────────

/** Verdict returned by {@link checkDangerousCommand}. */
export interface DangerousCommandVerdict {
  dangerous: boolean;
  /**
   * The exact command string that was classified (trimmed, and normalized when
   * `normalize` is set). Tools reuse it in deny messages and downstream checks.
   */
  classifiedCommand: string;
}

/**
 * Classify a command against the bypass-resistant dangerous-command patterns
 * (previously duplicated at BashTool/index.ts:129-141 and RunTool/index.ts:120-128;
 * pattern source: permissions/readonlyCommands `isDangerousBashCommand`, handles
 * var/$(...)/base64/|sh indirection).
 *
 * BashTool classifies the normalized command; RunTool classifies the raw
 * trimmed command — the difference is preserved via the `normalize` option.
 * Message wording ('detected:' vs 'blocked:') and BashTool's extra
 * decisionReason remain tool-side since they legitimately differ.
 *
 * @param rawCommand         Raw user command (trimmed here before classification).
 * @param options.normalize  When true, run permission normalizer before classification.
 */
export function checkDangerousCommand(
  rawCommand: string,
  options: { normalize?: boolean } = {}
): DangerousCommandVerdict {
  const trimmed = rawCommand.trim();
  const classifiedCommand = options.normalize ? normalizeCommand(trimmed) : trimmed;
  return {
    dangerous: isDangerousBashCommand(classifiedCommand),
    classifiedCommand,
  };
}
