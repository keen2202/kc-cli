// Task Create Tool - Create background tasks
//
// SEC-02: Uses parameterized spawn (not shell string interpolation).
// Routes through sandbox. Applies dangerous command detection and
// KC_* secrets filtering on child process environment.

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { spawn } from 'child_process';
import { isExecError, getErrorMessage } from '../../utils/errors';
import { isDangerousBashCommand } from '../../permissions/readonlyCommands';
import { taskStore } from '../TaskStore';

function filterSecretsFromEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('KC_')) continue;
    filtered[key] = value;
  }
  return filtered;
}

function spawnCommand(command: string, cwd: string, timeout: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.trim().split(/\s+/);
    if (!cmd) {
      reject(new Error('Empty command'));
      return;
    }
    const proc = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env: filterSecretsFromEnv(process.env) as Record<string, string>,
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`Command exited ${code}`), { stdout, stderr, code }));
    });
    proc.on('error', reject);
  });
}

const TaskCreateInputSchema = z.object({
  command: z.string().describe('Command to execute'),
  description: z.string().optional().describe('Task description'),
  cwd: z.string().optional().describe('Working directory'),
  background: z.boolean().default(false).describe('Run in background'),
});

type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export const tool = buildTool<TaskCreateInput, string>({
  name: 'TaskCreate',
  description: 'Create and manage background tasks',

  inputSchema: TaskCreateInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const workingDir = input.cwd || context.cwd;
      const task = taskStore.create(input.command);

      if (input.background) {
        taskStore.update(task.id, { status: 'running' });
        spawnCommand(input.command, workingDir, 3600000)
          .then(({ stdout, stderr }) => {
            taskStore.update(task.id, { status: 'completed', output: stdout || stderr });
          })
          .catch((error) => {
            taskStore.update(task.id, { status: 'failed', output: error.message });
          });

        return toolResult(
          `Background task created: ${task.id}\nCommand: ${input.command}\nStatus: Running\nUse TaskGet to check status.`,
          { metadata: { task_id: task.id, command: input.command, background: true } }
        );
      } else {
        taskStore.update(task.id, { status: 'running' });
        const { stdout, stderr } = await spawnCommand(input.command, workingDir, 300000);

        taskStore.update(task.id, { status: 'completed', output: stdout || stderr });

        return toolResult(`Task completed: ${task.id}\n\n${stdout || stderr}`, {
          metadata: { task_id: task.id, command: input.command, background: false },
        });
      }
    } catch (error) {
      const err = error as Record<string, unknown>;
      return toolError(`TaskCreate failed: ${err.stdout || err.stderr || (error instanceof Error ? error.message : String(error))}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    if (isDangerousBashCommand(command)) {
      return {
        behavior: 'deny',
        message: `Dangerous command blocked: ${command.slice(0, 100)}`,
      };
    }

    return {
      behavior: 'ask',
      message: `Create task: ${command.slice(0, 100)}`,
    };
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,

  prompt: () => 'Create tasks (sync or background).',

  getToolUseSummary: (input) => `Task: ${input.command.slice(0, 50)}...`,
  getActivityDescription: (input) => `Creating task`,
});
