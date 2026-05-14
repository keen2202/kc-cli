// Run Tool - Execute processes/commands with enhanced control

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const RunInputSchema = z.object({
  command: z.string().describe('Command to execute'),
  cwd: z.string().optional().describe('Working directory'),
  timeout: z.number().default(60).describe('Timeout in seconds'),
  env: z.record(z.string()).optional().describe('Environment variables'),
  shell: z.string().default('bash').describe('Shell to use'),
});

type RunInput = z.infer<typeof RunInputSchema>;

export const tool = buildTool<RunInput, string>({
  name: 'Run',
  description: 'Execute processes with enhanced control',

  inputSchema: RunInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const workingDir = input.cwd || context.cwd;
      const timeout = (input.timeout || 60) * 1000;

      const env = {
        ...process.env,
        ...(input.env || {}),
      };

      // The ToolExecutor pre-wraps commands for 'Run' tool at the executor level
      // (the authoritative sandbox enforcement point). Check for the executor's
      // wrapping marker to avoid double-wrapping.
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
          wrappedCmd = context.sandbox.wrapCommand(input.command, 'Run');
          sandboxed = context.sandbox.isAvailable();
          sandboxBackend = context.sandbox.getBackendName();
        } catch {
          // Sandbox denied — should have been caught by ToolExecutor
          throw new Error('Run tool requires sandbox but sandbox is not available');
        }
      }

      const { stdout, stderr } = await execAsync(wrappedCmd, {
        cwd: workingDir,
        timeout,
        env,
        shell: input.shell,
        maxBuffer: 50 * 1024 * 1024, // 50MB
      });

      const output = stdout || stderr;
      return toolResult(output, {
        metadata: {
          command: input.command,
          cwd: workingDir,
          exit_code: 0,
          sandboxed,
          sandboxBackend,
        },
      });
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      return toolError(`Command failed: ${output.trim()}`, {
        command: input.command,
        exit_code: error.code,
      });
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim().toLowerCase();

    // Block dangerous commands
    const dangerousPatterns = [
      'rm -rf /',
      'mkfs',
      'dd if=',
      'format /q',
      'shutdown',
      'reboot',
    ];

    for (const pattern of dangerousPatterns) {
      if (command.includes(pattern)) {
        return {
          behavior: 'deny',
          message: `Dangerous command blocked: ${pattern}`,
        };
      }
    }

    return {
      behavior: 'ask',
      message: `Execute: ${input.command.slice(0, 100)}`,
    };
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,

  prompt: () => 'Execute processes with timeout and env control.',

  getToolUseSummary: (input) => `Running: ${input.command}`,
  getActivityDescription: (input) => `Executing process`,
});
