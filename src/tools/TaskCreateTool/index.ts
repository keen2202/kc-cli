// Task Create Tool - Create background tasks

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface TaskRecord {
  id: string;
  command: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: number;
  output?: string;
}

// Session-level task storage
const tasks = new Map<string, TaskRecord>();
let nextTaskId = 1;

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
      const taskId = `task_${nextTaskId++}`;
      const workingDir = input.cwd || context.cwd;

      const task: TaskRecord = {
        id: taskId,
        command: input.command,
        status: 'pending',
        createdAt: Date.now(),
      };

      tasks.set(taskId, task);

      if (input.background) {
        // Run in background
        task.status = 'running';
        execAsync(input.command, {
          cwd: workingDir,
          timeout: 3600000, // 1 hour timeout
        })
          .then(({ stdout, stderr }) => {
            task.status = 'completed';
            task.output = stdout || stderr;
          })
          .catch((error) => {
            task.status = 'failed';
            task.output = error.message;
          });

        return toolResult(
          `Background task created: ${taskId}\n` +
          `Command: ${input.command}\n` +
          `Status: Running\n` +
          `Use TaskGet to check status.`,
          {
            metadata: {
              task_id: taskId,
              command: input.command,
              background: true,
            },
          }
        );
      } else {
        // Run synchronously
        task.status = 'running';
        const { stdout, stderr } = await execAsync(input.command, {
          cwd: workingDir,
          timeout: 300000, // 5 minute timeout
        });

        task.status = 'completed';
        task.output = stdout || stderr;

        return toolResult(
          `Task completed: ${taskId}\n\n${task.output}`,
          {
            metadata: {
              task_id: taskId,
              command: input.command,
              background: false,
            },
          }
        );
      }
    } catch (error: any) {
      return toolError(`TaskCreate failed: ${error.stdout || error.stderr || error.message}`);
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
