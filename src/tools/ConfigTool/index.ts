// Config Tool - Manage configuration settings

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import * as path from 'path';
import * as fs from 'fs';

const ConfigInputSchema = z.object({
  action: z.enum(['get', 'set', 'list', 'delete']).describe('Action to perform'),
  key: z.string().optional().describe('Configuration key'),
  value: z.string().optional().describe('Value to set (for set action)'),
  scope: z.enum(['user', 'project', 'session']).default('session').describe('Configuration scope'),
});

type ConfigInput = z.infer<typeof ConfigInputSchema>;

// Session config storage with size limits
const MAX_SESSION_CONFIG_ENTRIES = 100;
const MAX_SESSION_VALUE_SIZE = 10 * 1024; // 10KB per value
const sessionConfig = new Map<string, string>();

export const tool = buildTool<ConfigInput, string>({
  name: 'Config',
  description: 'Manage configuration settings',

  inputSchema: ConfigInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      switch (input.action) {
        case 'get': {
          if (!input.key) {
            return toolError('Key required for get action');
          }

          if (input.scope === 'session') {
            const value = sessionConfig.get(input.key);
            return toolResult(value ? `${input.key} = ${value}` : `Key not found: ${input.key}`);
          }

          return toolResult(`Config get: ${input.key} (scope: ${input.scope})\nWould read from config file in full implementation.`);
        }

        case 'set': {
          if (!input.key || !input.value) {
            return toolError('Key and value required for set action');
          }

          if (input.scope === 'session') {
            if (sessionConfig.size >= MAX_SESSION_CONFIG_ENTRIES) {
              return toolError(`Session config limit reached (${MAX_SESSION_CONFIG_ENTRIES} entries)`);
            }
            if (input.value.length > MAX_SESSION_VALUE_SIZE) {
              return toolError(`Value too large (max ${MAX_SESSION_VALUE_SIZE} bytes)`);
            }
            sessionConfig.set(input.key, input.value);
            return toolResult(`Set ${input.key} = ${input.value} (session scope)`, {
              metadata: { key: input.key, scope: input.scope },
            });
          }

          return toolResult(`Would set ${input.key} = ${input.value} in ${input.scope} config`);
        }

        case 'list': {
          if (input.scope === 'session') {
            const entries = Array.from(sessionConfig.entries());
            if (entries.length === 0) {
              return toolResult('No session configuration set');
            }

            const formatted = entries.map(([k, v]) => `  ${k} = ${v}`).join('\n');
            return toolResult(`Session configuration:\n${formatted}`);
          }

          return toolResult(`Listing ${input.scope} configuration...\nWould load from config file in full implementation.`);
        }

        case 'delete': {
          if (!input.key) {
            return toolError('Key required for delete action');
          }

          if (input.scope === 'session') {
            if (sessionConfig.has(input.key)) {
              sessionConfig.delete(input.key);
              return toolResult(`Deleted ${input.key} from session config`);
            }
            return toolResult(`Key not found: ${input.key}`);
          }

          return toolResult(`Would delete ${input.key} from ${input.scope} config`);
        }

        default:
          return toolError(`Unknown action: ${input.action}`);
      }
    } catch (error) {
      return toolError(`Config failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    if (input.action === 'get' || input.action === 'list') {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'readonly', reason: 'Config read is read-only' },
      };
    }

    return {
      behavior: 'ask',
      message: `${input.action} config: ${input.key || 'all'}`,
    };
  },

  isReadOnly: (input) => input.action === 'get' || input.action === 'list',
  isConcurrencySafe: () => true,

  prompt: () => 'Manage configuration (get/set/list/delete).',

  getToolUseSummary: (input) => `Config ${input.action}: ${input.key || ''}`,
  getActivityDescription: (input) => `${input.action}ing configuration`,
});
