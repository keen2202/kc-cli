// Task Create Tool - Create background tasks

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import { exec } from 'child_process';
import { promisify } from 'util';
import { isExecError, getErrorMessage } from '../../types/errors';
import { taskStore } from '../TaskStore';

const execAsync = promisify(exec);

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
        // Run in background
        taskStore.update(task.id, { status: 'running' });
        execAsync(input.command, {
          cwd: workingDir,
          timeout: 3600000, // 1 hour timeout
        })
          .then(({ stdout, stderr }) => {
            taskStore.update(task.id, {
              status: 'completed',
              output: stdout || stderr,
            });
          })
          .catch((error) => {
            taskStore.update(task.id, {
              status: 'failed',
              output: error.message,
            });
          });

        return toolResult(
          `Background task created: ${task.id}\n` +
          `Command: ${input.command}\n` +
          `Status: Running\n` +
          `Use TaskGet to check status.`,
          {
            metadata: {
              task_id: task.id,
              command: input.command,
              background: true,
            },
          }
        );
      } else {
        // Run synchronously
        taskStore.update(task.id, { status: 'running' });
        const { stdout, stderr } = await execAsync(input.command, {
          cwd: workingDir,
          timeout: 300000, // 5 minute timeout
        });

        taskStore.update(task.id, {
          status: 'completed',
          output: stdout || stderr,
        });

        return toolResult(
          `Task completed: ${task.id}\n\n${stdout || stderr}`,
          {
            metadata: {
              task_id: task.id,
              command: input.command,
              background: false,
            },
          }
        );
      }
    } catch (error) {
      const err = error as Record<string, unknown>;
      return toolError(`TaskCreate failed: ${err.stdout || err.stderr || (error instanceof Error ? error.message : String(error))}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => ({
    behavior: 'ask',
    message: `Create task: ${input.command.slice(0, 100)}`,
  }),

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,

  prompt: () => 'Create tasks (sync or background).',

  getToolUseSummary: (input) => `Task: ${input.command.slice(0, 50)}...`,
  getActivityDescription: (input) => `Creating task`,
});
