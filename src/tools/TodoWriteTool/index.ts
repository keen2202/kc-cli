// Todo Write Tool - Manage todo lists for tracking work

import { z } from 'zod';
import { readonlyAllow, buildTool, toolResult, toolError, toolFailure } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'low' | 'medium' | 'high';
}

// Session-level todo storage
const todoList = new Map<string, TodoItem>();
let nextId = 1;

const TodoWriteInputSchema = z.object({
  todos: z.array(z.object({
    content: z.string().describe('Todo item content'),
    status: z.enum(['pending', 'in_progress', 'completed']).default('pending'),
    priority: z.enum(['low', 'medium', 'high']).default('medium'),
  })).describe('Complete list of todos to set'),
});

type TodoWriteInput = z.infer<typeof TodoWriteInputSchema>;

export const tool = buildTool<TodoWriteInput, string>({
  name: 'TodoWrite',
  description: 'Manage todo lists for tracking work progress',

  inputSchema: TodoWriteInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      // Clear existing todos
      todoList.clear();

      // Set new todos
      for (const todo of input.todos) {
        const id = `todo_${nextId++}`;
        todoList.set(id, {
          id,
          content: todo.content,
          status: todo.status,
          priority: todo.priority,
        });
      }

      // Format todos for display
      if (todoList.size === 0) {
        return toolResult('Todo list cleared');
      }

      const formatted = Array.from(todoList.values())
        .map(todo => {
          const icon = todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '→' : '○';
          const priorityIcon = todo.priority === 'high' ? '🔴' : todo.priority === 'medium' ? '🟡' : '🟢';
          return `  ${icon} ${priorityIcon} ${todo.content}`;
        })
        .join('\n');

      const summary = `${todoList.size} todo(s):\n${formatted}`;
      return toolResult(summary, {
        metadata: {
          total: todoList.size,
          completed: Array.from(todoList.values()).filter(t => t.status === 'completed').length,
          pending: Array.from(todoList.values()).filter(t => t.status === 'pending').length,
        },
      });
    } catch (error) {
      return toolFailure('TodoWrite', error);
    }
  },

  checkPermissions: () => readonlyAllow('Todo management is safe'),

  isReadOnly: () => false,
  isConcurrencySafe: () => true,

  prompt: () => 'Update todo list. Provide complete list each time.',

  getToolUseSummary: (input) => `Updating ${input.todos.length} todos`,
  getActivityDescription: (input) => `Managing todo list`,
});
