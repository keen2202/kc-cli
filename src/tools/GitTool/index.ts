// Git Tool - Execute Git operations

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import { DANGEROUS_GIT_PATTERNS, isReadOnlyGitCommand } from '../../permissions/readonlyCommands';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const GitInputSchema = z.object({
  command: z.string().describe('Git command to execute (without "git" prefix)'),
  cwd: z.string().optional().describe('Working directory (defaults to project root)'),
  timeout: z.number().default(60).describe('Timeout in seconds'),
});

type GitInput = z.infer<typeof GitInputSchema>;

export const tool = buildTool<GitInput, string>({
  name: 'Git',
  description: 'Execute Git operations',

  inputSchema: GitInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const workingDir = input.cwd || context.cwd;
      const timeout = (input.timeout || 60) * 1000;

      // Use -c color.ui=never for clean, parseable output
      const gitCmd = `git -c color.ui=never ${input.command}`;

      const { stdout, stderr } = await execAsync(gitCmd, {
        cwd: workingDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      // Sanitize output: truncate if extremely large
      let output = (stdout || stderr || '').trim();
      if (output.length > 100_000) {
        output = output.slice(0, 100_000) + '\n\n[Output truncated — too large]';
      }

      return toolResult(output, {
        metadata: { command: input.command, cwd: workingDir },
      });
    } catch (error) {
      const err = error as Record<string, unknown>;
      const output = String(err.stdout || err.stderr || (error instanceof Error ? error.message : '') || '').trim();
      return toolError(`Git command failed: ${output.slice(0, 2000)}`, {
        command: input.command,
      });
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    // Check for dangerous commands
    for (const pattern of DANGEROUS_GIT_PATTERNS) {
      if (pattern.test(command)) {
        return {
          behavior: 'deny',
          message: `Dangerous Git command: ${command}`,
        };
      }
    }

    // Check if read-only
    if (isReadOnlyGitCommand(command)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'readonly', reason: 'Read-only Git operation' },
      };
    }

    return {
      behavior: 'ask',
      message: `Execute Git: ${command}`,
    };
  },

  isReadOnly: (input) => {
    return isReadOnlyGitCommand(input.command);
  },
  isConcurrencySafe: () => false,
  isDestructive: (input) => {
    return DANGEROUS_GIT_PATTERNS.some(pattern => pattern.test(input.command));
  },

  prompt: () => 'Execute Git commands. Read-only operations are auto-allowed.',

  getToolUseSummary: (input) => `git ${input.command}`,
  getActivityDescription: (input) => `Running git ${input.command}`,
});
