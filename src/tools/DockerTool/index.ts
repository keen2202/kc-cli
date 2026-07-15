// Docker Tool - Manage Docker containers and images
//
// SEC-01: Uses parameterized spawn (not shell string interpolation) to prevent
// command injection. Shell metacharacters are blocked in checkPermissions.
// Docker is routed through the sandbox (enforcement: 'required').

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { spawn } from 'child_process';
import { isExecError, getErrorMessage } from '../../utils/errors';

const DockerInputSchema = z.object({
  command: z.string().describe('Docker command (without "docker" prefix)'),
  timeout: z.number().default(60).describe('Timeout in seconds'),
});

type DockerInput = z.infer<typeof DockerInputSchema>;

const READONLY_COMMANDS = new Set([
  'ps', 'images', 'inspect', 'logs', 'stats',
  'version', 'info', 'network ls', 'volume ls',
]);

// Shell metacharacters that enable command injection
const DANGEROUS_METACHARACTERS = /[;|&`$(){}[\]#!~<>]/;

const DANGEROUS_COMMANDS = [
  /rm\s+-f/,
  /rm\s+-rf/,
  /rm\s+-r\b/,
  /rm\s+--force/,
  /rmi\s+-f/,
  /system\s+prune/,
  /network\s+prune/,
  /volume\s+prune/,
  /container\s+prune/,
  /image\s+prune/,
];

function isDangerousDockerCommand(command: string): boolean {
  if (DANGEROUS_METACHARACTERS.test(command)) return true;
  for (const pattern of DANGEROUS_COMMANDS) {
    if (pattern.test(command)) return true;
  }
  return false;
}

function spawnDocker(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`docker exited ${code}`), { stdout, stderr, code }));
    });
    proc.on('error', reject);
  });
}

export const tool = buildTool<DockerInput, string>({
  name: 'Docker',
  description: 'Manage Docker containers and images',

  inputSchema: DockerInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const timeout = (Number.isFinite(input.timeout) ? input.timeout : 60) * 1000;
      const args = input.command.trim().split(/\s+/);

      const { stdout, stderr } = await spawnDocker(args, timeout);

      return toolResult((stdout || stderr).trim(), {
        metadata: { command: input.command },
      });
    } catch (error) {
      if (isExecError(error)) {
        const output = String((error as any).stdout || (error as any).stderr || error.message || '').trim();
        return toolError(`Docker failed: ${output}`);
      }
      return toolError(`Docker failed: ${getErrorMessage(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    if (isDangerousDockerCommand(command)) {
      return {
        behavior: 'deny',
        message: `Dangerous Docker command blocked: ${command}`,
      };
    }

    const baseCommand = command.split(/\s+/)[0]!;
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
    const spaceIdx = command.indexOf(' ');
    return spaceIdx > 0 && READONLY_COMMANDS.has(command.slice(0, spaceIdx));
  },
  isConcurrencySafe: () => false,
  isDestructive: (input) => isDangerousDockerCommand(input.command),

  prompt: () => 'Manage Docker containers. Read-only ops auto-allowed.',

  getToolUseSummary: (input) => `docker ${input.command}`,
  getActivityDescription: (input) => `Running docker ${input.command}`,
});
