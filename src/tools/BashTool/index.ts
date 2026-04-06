// Bash Tool - Shell command execution with security checks

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolUseContext, ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import { hasPermissionsToUseTool } from '../../permissions/engine';
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

      // Execute command
      const { stdout, stderr } = await execAsync(`bash -c '${input.command.replace(/'/g, "'\\''")}'`, {
        cwd: workingDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      return toolResult(stdout, {
        isError: false,
        metadata: { exitCode: 0, stderr: stderr.trim() || undefined },
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
    const dangerousPatterns = [
      /\brm\s+-rf\s+\/\b/,
      /\bmkfs\b/,
      /\bdd\s+if=.*of=\/dev\//,
      /\bFormat\b.*\/Q/,  // Windows
      /\bshutdown\b.*\/r/,
    ];

    for (const pattern of dangerousPatterns) {
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
    const readOnlyPatterns = [
      /^ls\b/,
      /^cat\b/,
      /^head\b/,
      /^tail\b/,
      /^grep\b/,
      /^find\b/,
      /^git\s+(status|log|diff|branch|remote)\b/,
      /^pwd\b/,
      /^whoami\b/,
      /^date\b/,
      /^echo\b/,
    ];

    for (const pattern of readOnlyPatterns) {
      if (pattern.test(command)) {
        return {
          behavior: 'allow',
          updatedInput: input,
          decisionReason: {
            type: 'readonly',
            reason: 'Read-only command',
          },
        };
      }
    }

    // Default: ask for permission
    return {
      behavior: 'ask',
      message: `Execute bash command: ${command}`,
    };
  },

  isReadOnly: (input) => {
    const readOnlyPatterns = [
      /^ls\b/, /^cat\b/, /^head\b/, /^tail\b/, /^grep\b/,
      /^find\b/, /^git\s+(status|log|diff)\b/, /^pwd\b/,
    ];
    return readOnlyPatterns.some(p => p.test(input.command));
  },

  prompt: () => 'Execute bash commands. Supports pipes, redirects, and background processes.',

  getToolUseSummary: (input) => `Running: ${input.command}`,
  getActivityDescription: (input) => `Executing bash command`,
});
