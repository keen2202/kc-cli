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
import { DEFAULT_MAX_BUFFER } from '../../constants';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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

      // Execute wrapped command - prefer ExecutionEnv abstraction when available
      if (context.env) {
        const result = await context.env.shell.exec(wrappedCmd, {
          cwd: workingDir,
          timeout,
          signal: context.abortController?.signal,
        });

        if (result.exitCode !== 0) {
          return toolResult(result.stdout, {
            isError: true,
            message: `Command failed: ${result.stderr || 'non-zero exit code'}`,
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
      }

      // Fallback: direct child_process exec
      const { stdout, stderr } = await execAsync(wrappedCmd, {
        cwd: workingDir,
        timeout,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });

      return toolResult(stdout, {
        isError: false,
        metadata: {
          exitCode: 0,
          stderr: stderr.trim() || undefined,
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
