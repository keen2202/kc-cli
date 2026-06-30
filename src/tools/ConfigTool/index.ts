// Config Tool - Manage configuration settings

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { getCacheManager } from '../../services/cache';

const ConfigInputSchema = z.object({
  action: z.enum(['get', 'set', 'list', 'delete']).describe('Action to perform'),
  key: z.string().optional().describe('Configuration key (supports dotted notation, e.g. "memory.enabled")'),
  value: z.string().optional().describe('Value to set (for set action)'),
  scope: z.enum(['user', 'project', 'session']).default('session').describe('Configuration scope'),
});

type ConfigInput = z.infer<typeof ConfigInputSchema>;

// Session config storage with TieredCache for LRU eviction and hit rate tracking
const MAX_SESSION_CONFIG_ENTRIES = 100;
const MAX_SESSION_VALUE_SIZE = 10 * 1024; // 10KB per value
const sessionConfig = getCacheManager().getOrCreate<string>('session-config', 'session', {
  maxSize: MAX_SESSION_CONFIG_ENTRIES,
  maxBytes: MAX_SESSION_CONFIG_ENTRIES * MAX_SESSION_VALUE_SIZE,
});

/**
 * Resolve config file path for a given scope.
 */
function getConfigPath(scope: 'user' | 'project', cwd: string): string {
  if (scope === 'user') {
    return path.join(os.homedir(), '.kc-cli', 'settings.json');
  }
  return path.join(cwd, '.kc-cli', 'settings.json');
}

/**
 * Read config file and return parsed JSON object.
 */
function readConfigFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write config file, creating parent directories if needed.
 */
function writeConfigFile(filePath: string, data: Record<string, unknown>): boolean {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a nested value from an object using dot notation.
 */
function getNestedKey(obj: Record<string, unknown>, key: string): unknown {
  const parts = key.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a nested value in an object, creating intermediate objects as needed.
 */
function setNestedKey(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== 'object' || Array.isArray(current[part])) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

/**
 * Delete a nested key from an object.
 */
function deleteNestedKey(obj: Record<string, unknown>, key: string): boolean {
  const parts = key.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    if (!(part in current) || typeof current[part] !== 'object') return false;
    current = current[part] as Record<string, unknown>;
  }
  const lastKey = parts[parts.length - 1]!;
  if (lastKey in current) {
    delete current[lastKey];
    return true;
  }
  return false;
}

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

          const filePath = getConfigPath(input.scope, context.cwd);
          const config = readConfigFile(filePath);
          if (!config) {
            return toolResult(`No ${input.scope} configuration file found`);
          }
          const value = getNestedKey(config, input.key);
          if (value === undefined) {
            return toolResult(`Key not found: ${input.key} (${input.scope} scope)`);
          }
          return toolResult(`${input.key} = ${JSON.stringify(value)}`);
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

          const filePath = getConfigPath(input.scope, context.cwd);
          let config = readConfigFile(filePath) ?? {};
          // Parse value: try JSON first, fall back to string
          let parsedValue: unknown = input.value;
          try {
            parsedValue = JSON.parse(input.value);
          } catch {
            // Keep as string
          }
          setNestedKey(config, input.key, parsedValue);
          if (!writeConfigFile(filePath, config)) {
            return toolError(`Failed to write ${input.scope} configuration file`);
          }
          return toolResult(`Set ${input.key} = ${input.value} (${input.scope} scope)`, {
            metadata: { key: input.key, scope: input.scope },
          });
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

          const filePath = getConfigPath(input.scope, context.cwd);
          const config = readConfigFile(filePath);
          if (!config || Object.keys(config).length === 0) {
            return toolResult(`No ${input.scope} configuration found`);
          }
          const formatted = JSON.stringify(config, null, 2);
          return toolResult(`${input.scope} configuration:\n${formatted}`);
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

          const filePath = getConfigPath(input.scope, context.cwd);
          const config = readConfigFile(filePath);
          if (!config) {
            return toolResult(`No ${input.scope} configuration file found`);
          }
          if (!deleteNestedKey(config, input.key)) {
            return toolResult(`Key not found: ${input.key} (${input.scope} scope)`);
          }
          if (!writeConfigFile(filePath, config)) {
            return toolError(`Failed to write ${input.scope} configuration file`);
          }
          return toolResult(`Deleted ${input.key} from ${input.scope} config`);
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
