// Task Get Tool - Get task status and output

import { z } from 'zod';
import { readonlyAllow, buildTool, toolResult, toolError, toolFailure } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { taskStore } from '../TaskStore';

const TaskGetInputSchema = z.object({
  task_id: z.string().optional().describe('Task ID to query (omit for all tasks)'),
  status_filter: z.enum(['pending', 'running', 'completed', 'failed']).optional().describe('Filter by status'),
});

type TaskGetInput = z.infer<typeof TaskGetInputSchema>;

export const tool = buildTool<TaskGetInput, string>({
  name: 'TaskGet',
  description: 'Get task status and output',

  inputSchema: TaskGetInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      if (input.task_id) {
        // Get specific task
        const task = taskStore.get(input.task_id);
        if (!task) {
          return toolError(`Task not found: ${input.task_id}`);
        }

        const elapsed = ((Date.now() - task.createdAt) / 1000).toFixed(1);
        return toolResult(
          `Task: ${task.id}\n` +
          `Command: ${task.command}\n` +
          `Status: ${task.status}\n` +
          `Created: ${elapsed}s ago\n` +
          (task.output ? `\nOutput:\n${task.output}` : ''),
          {
            metadata: {
              task_id: task.id,
              status: task.status,
            },
          }
        );
      }

      // List all tasks
      let filteredTasks = taskStore.getAll();
      if (input.status_filter) {
        filteredTasks = filteredTasks.filter(t => t.status === input.status_filter);
      }

      if (filteredTasks.length === 0) {
        return toolResult('No tasks found');
      }

      const formatted = filteredTasks
        .map(task => {
          const icon = task.status === 'completed' ? '✓' : task.status === 'failed' ? '✗' : '⟳';
          const elapsed = ((Date.now() - task.createdAt) / 1000).toFixed(0);
          return `  ${icon} ${task.id} [${task.status}] ${elapsed}s - ${task.command.slice(0, 50)}`;
        })
        .join('\n');

      return toolResult(
        `${filteredTasks.length} task(s):\n${formatted}`,
        {
          metadata: {
            total: filteredTasks.length,
            statuses: {
              pending: filteredTasks.filter(t => t.status === 'pending').length,
              running: filteredTasks.filter(t => t.status === 'running').length,
              completed: filteredTasks.filter(t => t.status === 'completed').length,
              failed: filteredTasks.filter(t => t.status === 'failed').length,
            },
          },
        }
      );
    } catch (error) {
      return toolFailure('TaskGet', error);
    }
  },

  checkPermissions: () => readonlyAllow('Task status query is read-only'),

  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  prompt: () => 'Get task status by ID or list all tasks.',

  getToolUseSummary: (input) => input.task_id ? `Task: ${input.task_id}` : 'Listing tasks',
  getActivityDescription: (input) => 'Checking task status',
});
