// Bash Tool - Shell command execution with security checks

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolUseContext, ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import { hasPermissionsToUseTool } from '../../permissions/engine';
import { DANGEROUS_BASH_PATTERNS, isReadOnlyBashCommand } from '../../permissions/readonlyCommands';
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
      const timeout = (input.timeout || 30) * 1000; // Convert to ms

      // The ToolExecutor pre-wraps commands for 'Bash' tool at the executor level
      // (the authoritative sandbox enforcement point). If the command has already
      // been wrapped, we use it as-is to avoid double-wrapping.
      // Check for the executor's wrapping marker on the input.
      const SANDBOX_WRAPPED_MARKER = Symbol.for('kc-cli.sandbox-wrapped');
      const alreadyWrapped = (input as any)[SANDBOX_WRAPPED_MARKER] === true;

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

      // Execute wrapped command
      const { stdout, stderr } = await execAsync(wrappedCmd, {
        cwd: workingDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      // Extract stdout/stderr from exec error
      if (error && typeof error === 'object' && 'stdout' in error) {
        const execError = error as any;
        return toolResult(execError.stdout || '', {
          isError: true,
          message: `Command failed: ${execError.stderr || errorMessage}`,
          metadata: { exitCode: execError.code || 1, stderr: execError.stderr || errorMessage },
        });
      }
      return toolError(`Failed to execute command: ${errorMessage}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    // Check for dangerous commands
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          behavior: 'deny',
          message: `Dangerous command detected: ${command}`,
          decisionReason: {
            type: 'dangerous_command',
            reason: 'Command matches dangerous pattern',
          },
        };
      }
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
