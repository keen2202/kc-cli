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

      const { stdout, stderr } = await execAsync(input.command, {
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
