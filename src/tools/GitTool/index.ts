// Git Tool - Execute Git operations

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import { DANGEROUS_GIT_PATTERNS, isReadOnlyGitCommand } from '../../permissions/readonlyCommands';
import { spawn } from 'child_process';
import { isExecError, getErrorMessage } from '../../types/errors';
import { DEFAULT_MAX_BUFFER } from '../../constants';

// Shell metacharacters and control chars that could enable command injection
const SHELL_METACHAR_REGEX = /[;&|`$(){}!#~<>\n\r]/;

function parseGitArgs(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('Empty git command');

  if (SHELL_METACHAR_REGEX.test(trimmed)) {
    throw new Error(
      `Git command contains forbidden shell metacharacters: ${trimmed.slice(0, 100)}`
    );
  }

  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else if (ch === '\\' && i + 1 < trimmed.length) {
        const next = trimmed[i + 1];
        if (next === '"' || next === '\\') {
          current += next;
          i++;
        } else {
          current += ch;
        }
      } else {
        current += ch;
      }
    } else if (ch === "'") {
      inSingle = true;
    } else if (ch === '"') {
      inDouble = true;
    } else if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }

  if (current.length > 0) args.push(current);
  return args;
}

function spawnGit(
  command: string,
  cwd: string,
  timeout: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const args = parseGitArgs(command);
    const child = spawn('git', ['-c', 'color.ui=never', ...args], {
      cwd,
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > DEFAULT_MAX_BUFFER) {
        child.kill();
        reject(new Error('Git output exceeded max buffer size'));
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > DEFAULT_MAX_BUFFER) {
        child.kill();
        reject(new Error('Git stderr output exceeded max buffer size'));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`git exited with code ${code}`) as Error & {
          code: number | null;
          stdout: string;
          stderr: string;
        };
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

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
