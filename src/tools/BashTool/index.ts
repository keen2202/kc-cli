// Bash Tool - Shell command execution with security checks

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolUseContext, ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { hasPermissionsToUseTool } from '../../permissions/engine';
import { isReadOnlyBashCommand } from '../../permissions/readonlyCommands';
import { isExecError, getErrorMessage } from '../../utils/errors';
import { buildSafeEnv } from '../RunTool/secrets';
import {
  applySandboxPreWrap,
  checkDangerousCommand,
  guardsWindowsFind,
  handleNonZeroExit,
} from '../shared/command-execution';

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
      const findGuard = guardsWindowsFind(input.command, process.platform);
      if (findGuard.blocked) {
        return toolError(findGuard.errorMessage, {
          command: input.command,
          platform: process.platform,
        });
      }

      // The ToolExecutor pre-wraps commands for 'Bash' tool at the executor level
      // (the authoritative sandbox enforcement point). If the command has already
      // been wrapped, we use it as-is to avoid double-wrapping.
      // Shared helper checks the executor's wrapping marker + HMAC signature
      // and falls back to wrapping via the shared sandbox manager.
      const wrap = applySandboxPreWrap({
        command: input.command,
        toolName: 'Bash',
        input: input as Record<string, unknown>,
        sandbox: context.sandbox,
      });

      // Execute wrapped command via ExecutionEnv abstraction
      // Pass filtered env to prevent KC_* secrets leak (SEC-03)
      const result = await context.env.shell.exec(wrap.wrappedCmd, {
        cwd: workingDir,
        timeout,
        env: buildSafeEnv(),
        signal: context.abortController?.signal,
      });

      if (result.exitCode !== 0) {
        // Append a Windows-native replacement hint when a Unix-only command
        // fails with a "not recognized" error (e.g. grep/awk on cmd.exe).
        const failure = handleNonZeroExit({
          exitCode: result.exitCode,
          command: input.command,
          scanText: `${result.stderr}\n${result.stdout}`,
          detail: result.stderr || 'non-zero exit code',
          platform: process.platform,
        });
        return toolResult(result.stdout, {
          isError: true,
          message: failure.message,
          metadata: { exitCode: result.exitCode, stderr: result.stderr },
        });
      }

      return toolResult(result.stdout, {
        isError: false,
        metadata: {
          exitCode: 0,
          stderr: result.stderr.trim() || undefined,
          sandboxed: wrap.sandboxed,
          sandboxBackend: wrap.sandboxBackend,
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
    // Check for dangerous commands (bypass-resistant: handles var/$(...)/base64/|sh)
    const dangerousVerdict = checkDangerousCommand(input.command, { normalize: true });
    if (dangerousVerdict.dangerous) {
      return {
        behavior: 'deny',
        message: `Dangerous command detected: ${dangerousVerdict.classifiedCommand}`,
        decisionReason: {
          type: 'dangerous_command',
          reason: 'Command matches dangerous pattern',
        },
      };
    }

    // Check for read-only commands
    const command = dangerousVerdict.classifiedCommand;
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
