// Docker Tool - Manage Docker containers and images

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { exec } from 'child_process';
import { isExecError, getErrorMessage } from '../../utils/errors';
import { DEFAULT_MAX_BUFFER } from '../../constants';
import { promisify } from 'util';

const execAsync = promisify(exec);

const DockerInputSchema = z.object({
  command: z.string().describe('Docker command (without "docker" prefix)'),
  timeout: z.number().default(60).describe('Timeout in seconds'),
});

type DockerInput = z.infer<typeof DockerInputSchema>;

const READONLY_COMMANDS = new Set([
  'ps', 'images', 'inspect', 'logs', 'stats',
  'version', 'info', 'network ls', 'volume ls',
]);

const DANGEROUS_COMMANDS = [
  /rm\s+-f/,
  /rmi\s+-f/,
  /system\s+prune/,
  /network\s+prune/,
  /volume\s+prune/,
];

export const tool = buildTool<DockerInput, string>({
  name: 'Docker',
  description: 'Manage Docker containers and images',

  inputSchema: DockerInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const timeout = (Number.isFinite(input.timeout) ? input.timeout : 60) * 1000;

      const { stdout, stderr } = await execAsync(`docker ${input.command}`, {
        timeout,
        maxBuffer: DEFAULT_MAX_BUFFER,
      });

      return toolResult((stdout || stderr).trim(), {
        metadata: { command: input.command },
      });
    } catch (error) {
      if (isExecError(error)) {
        const output = String(error.stdout || error.stderr || error.message || '').trim();
        return toolError(`Docker failed: ${output}`);
      }
      return toolError(`Docker failed: ${getErrorMessage(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    for (const pattern of DANGEROUS_COMMANDS) {
      if (pattern.test(command)) {
        return {
          behavior: 'deny',
          message: `Dangerous Docker command: ${command}`,
        };
      }
    }

    const baseCommand = command.split(' ')[0];
    if (READONLY_COMMANDS.has(command) || READONLY_COMMANDS.has(baseCommand)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'readonly', reason: 'Read-only Docker operation' },
      };
    }

    return {
      behavior: 'ask',
      message: `Docker: ${command}`,
    };
  },

  isReadOnly: (input) => {
    const command = input.command.trim();
    if (READONLY_COMMANDS.has(command)) return true;
    // Use indexOf instead of split to avoid allocating array
    const spaceIdx = command.indexOf(' ');
    return spaceIdx > 0 && READONLY_COMMANDS.has(command.slice(0, spaceIdx));
  },
  isConcurrencySafe: () => false,
  isDestructive: (input) => DANGEROUS_COMMANDS.some(p => p.test(input.command)),

  prompt: () => 'Manage Docker containers. Read-only ops auto-allowed.',

  getToolUseSummary: (input) => `docker ${input.command}`,
  getActivityDescription: (input) => `Running docker ${input.command}`,
});
