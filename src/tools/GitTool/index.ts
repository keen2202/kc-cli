// Git Tool - Execute Git operations

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const GitInputSchema = z.object({
  command: z.string().describe('Git command to execute (without "git" prefix)'),
  cwd: z.string().optional().describe('Working directory (defaults to project root)'),
  timeout: z.number().default(30).describe('Timeout in seconds'),
});

type GitInput = z.infer<typeof GitInputSchema>;

// Read-only Git commands
const READONLY_COMMANDS = new Set([
  'status', 'log', 'diff', 'branch', 'remote', 'show',
  'ls-files', 'ls-tree', 'cat-file', 'describe', 'tag',
  'shortlog', 'name-rev', 'rev-parse', 'rev-list',
  'show-ref', 'for-each-ref', 'config --list',
]);

// Dangerous Git commands
const DANGEROUS_COMMANDS = [
  /push\s+--force/,
  /reset\s+--hard/,
  /clean\s+-fd/,
  /filter-branch/,
];

export const tool = buildTool<GitInput, string>({
  name: 'Git',
  description: 'Execute Git operations',

  inputSchema: GitInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const workingDir = input.cwd || context.cwd;
      const timeout = (input.timeout || 30) * 1000;

      const { stdout, stderr } = await execAsync(`git ${input.command}`, {
        cwd: workingDir,
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      });

      const output = stdout || stderr;
      return toolResult(output.trim(), {
        metadata: { command: input.command, cwd: workingDir },
      });
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      return toolError(`Git command failed: ${output.trim()}`, {
        command: input.command,
      });
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    // Check for dangerous commands
    for (const pattern of DANGEROUS_COMMANDS) {
      if (pattern.test(command)) {
        return {
          behavior: 'deny',
          message: `Dangerous Git command: ${command}`,
        };
      }
    }

    // Check if read-only
    const baseCommand = command.split(' ')[0];
    if (READONLY_COMMANDS.has(baseCommand) || READONLY_COMMANDS.has(command)) {
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
    const baseCommand = input.command.split(' ')[0];
    return READONLY_COMMANDS.has(baseCommand) || READONLY_COMMANDS.has(input.command);
  },
  isConcurrencySafe: () => false,
  isDestructive: (input) => {
    return DANGEROUS_COMMANDS.some(pattern => pattern.test(input.command));
  },

  prompt: () => 'Execute Git commands. Read-only operations are auto-allowed.',

  getToolUseSummary: (input) => `git ${input.command}`,
  getActivityDescription: (input) => `Running git ${input.command}`,
});
