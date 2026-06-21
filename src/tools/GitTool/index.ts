// Git Tool - Execute Git operations

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { DANGEROUS_GIT_PATTERNS, isReadOnlyGitCommand } from '../../permissions/readonlyCommands';
import { isExecError, getErrorMessage } from '../../utils/errors';
import { spawnGit, parseGitArgs } from '../../utils/git';

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
      const timeout = (Number.isFinite(input.timeout) ? input.timeout : 60) * 1000;

      const { stdout, stderr } = await spawnGit(input.command, workingDir, timeout);

      let output = (stdout || stderr || '').trim();
      if (output.length > 100_000) {
        output = output.slice(0, 100_000) + '\n\n[Output truncated — too large]';
      }

      return toolResult(output, {
        metadata: { command: input.command, cwd: workingDir },
      });
    } catch (error) {
      if (isExecError(error)) {
        const output = String(error.stdout || error.stderr || error.message || '').trim();
        return toolError(`Git command failed: ${output.slice(0, 2000)}`, {
          command: input.command,
        });
      }
      return toolError(`Git command failed: ${getErrorMessage(error).slice(0, 2000)}`, {
        command: input.command,
      });
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    for (const pattern of DANGEROUS_GIT_PATTERNS) {
      if (pattern.test(command)) {
        return {
          behavior: 'deny',
          message: `Dangerous Git command: ${command}`,
        };
      }
    }

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
