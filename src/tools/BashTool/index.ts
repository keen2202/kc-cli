// Bash Tool - Shell command execution with security checks

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolUseContext, ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { hasPermissionsToUseTool } from '../../permissions/engine';
import { isReadOnlyBashCommand, isDangerousBashCommand } from '../../permissions/readonlyCommands';
import { normalizeCommand } from '../../permissions/commandNormalizer';
import { isAlreadySandboxWrapped } from '../../executors/toolExecutor';
import { isExecError, getErrorMessage } from '../../utils/errors';
import { buildSafeEnv } from '../RunTool/secrets';
import {
  detectUnixFindOnWindows,
  getWindowsCommandHint,
  isCommandNotFoundOutput,
} from './windows-compat';

const BashInputSchema = z.object({
  command: z.string().describe('The bash command to execute'),
  timeout: z.number().default(30).describe('Timeout in seconds'),
  background: z.boolean().default(false).describe('Run in background'),
  workingDir: z.string().optional().describe('Working directory'),
});

type BashInput = z.infer<typeof BashInputSchema>;

export const tool = buildTool<BashInput, string>({
  name: 'Bash',
  description: 'Execute bash commands on the system',

  inputSchema: BashInputSchema,

  call: async (input, context, onProgress): Promise<ToolResultType<string>> => {
    try {
      onProgress?.({
        toolName: 'Bash',
        status: 'Executing command',
        message: input.command,
      });

      const workingDir = input.workingDir || context.cwd;
      const timeout = (Number.isFinite(input.timeout) ? input.timeout : 30) * 1000; // Convert to ms

      // Windows guard: Unix `find` syntax resolves to FIND.EXE (text search)
      // under cmd.exe and fails with a cryptic parameter error. Fail fast with
      // an actionable diagnosis instead of a confusing downstream failure.
      const findIncompat = detectUnixFindOnWindows(input.command);
      if (findIncompat) {
        return toolError(`[tool_execution_failed] Command not executed: ${findIncompat}`, {
          command: input.command,
          platform: process.platform,
        });
      }

      // The ToolExecutor pre-wraps commands for 'Bash' tool at the executor level
      // (the authoritative sandbox enforcement point). If the command has already
      // been wrapped, we use it as-is to avoid double-wrapping.
      // Check for the executor's wrapping marker and HMAC signature on the input.
      const inputRecord = input as Record<string, unknown>;
      const alreadyWrapped = isAlreadySandboxWrapped(inputRecord, 'Bash');

      let wrappedCmd = input.command;
      let sandboxed = false;
      let sandboxBackend: string | undefined;

      if (alreadyWrapped) {
        // Executor already wrapped the command — use it directly
        sandboxed = context.sandbox?.isAvailable() ?? false;
        sandboxBackend = context.sandbox?.getBackendName();
      } else if (context.sandbox) {
        // Fallback: wrap via shared sandbox manager from ToolExecutor
        try {
          wrappedCmd = context.sandbox.wrapCommand(input.command, 'Bash');
          sandboxed = context.sandbox.isAvailable();
          sandboxBackend = context.sandbox.getBackendName();
        } catch {
          // Sandbox denied — this should have been caught by ToolExecutor already
          throw new Error('Bash tool requires sandbox but sandbox is not available');
        }
      }

      // Execute wrapped command via ExecutionEnv abstraction
      // Pass filtered env to prevent KC_* secrets leak (SEC-03)
      const result = await context.env.shell.exec(wrappedCmd, {
        cwd: workingDir,
        timeout,
        env: buildSafeEnv(),
        signal: context.abortController?.signal,
      });

      if (result.exitCode !== 0) {
        // Append a Windows-native replacement hint when a Unix-only command
        // fails with a "not recognized" error (e.g. grep/awk on cmd.exe).
        const combinedOutput = `${result.stderr}\n${result.stdout}`;
        const winHint = isCommandNotFoundOutput(combinedOutput)
          ? getWindowsCommandHint(input.command)
          : null;
        return toolResult(result.stdout, {
          isError: true,
          message: `Command failed (exit ${result.exitCode}): ${result.stderr || 'non-zero exit code'}${winHint ? `\n${winHint}` : ''}`,
          metadata: { exitCode: result.exitCode, stderr: result.stderr },
        });
      }

      return toolResult(result.stdout, {
        isError: false,
        metadata: {
          exitCode: 0,
          stderr: result.stderr.trim() || undefined,
          sandboxed,
          sandboxBackend,
        },
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      if (isExecError(error)) {
        return toolResult(error.stdout || '', {
          isError: true,
          message: `Command failed: ${error.stderr || errorMessage}`,
          metadata: { exitCode: error.code || 1, stderr: error.stderr || errorMessage },
        });
      }
      return toolError(`Failed to execute command: ${errorMessage}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = normalizeCommand(input.command.trim());

    // Check for dangerous commands (bypass-resistant: handles var/$(...)/base64/|sh)
    if (isDangerousBashCommand(command)) {
      return {
        behavior: 'deny',
        message: `Dangerous command detected: ${command}`,
        decisionReason: {
          type: 'dangerous_command',
          reason: 'Command matches dangerous pattern',
        },
      };
    }

    // Check for read-only commands
    if (isReadOnlyBashCommand(command)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'readonly',
          reason: 'Read-only command',
        },
      };
    }

    // Default: ask for permission
    return {
      behavior: 'ask',
      message: `Execute bash command: ${command}`,
    };
  },

  isReadOnly: (input) => {
    return isReadOnlyBashCommand(input.command);
  },

  prompt: () => 'Execute bash commands. Supports pipes, redirects, and background processes.',

  getToolUseSummary: (input) => `Running: ${input.command}`,
  getActivityDescription: (input) => `Executing bash command`,
});
