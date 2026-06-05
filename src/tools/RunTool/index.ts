// Run Tool - Execute processes/commands with enhanced control

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { isAlreadySandboxWrapped } from '../../executors/toolExecutor';
import { isExecError, getErrorMessage } from '../../utils/errors';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DANGEROUS_BASH_PATTERNS } from '../../permissions/readonlyCommands';
import { logger } from '../../services/logger';
import { LARGE_MAX_BUFFER } from '../../constants';

const execAsync = promisify(exec);

/**
 * Environment variables that can lead to code injection or privilege escalation
 * when set by untrusted input. These are filtered before merging into process env.
 */
const DANGEROUS_ENV_VARS = new Set([
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONSTARTUP',
  'PYTHONPATH',
  'PERL5LIB',
  'PERLLIB',
  'RUBYOPT',
  'RUBYLIB',
  'PATH',
  'HOME',
  'SHELL',
  'BASH_ENV',
  'PROMPT_COMMAND',
  'IFS',
  'CDPATH',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'ANSIBLE_CONFIG',
  'DOCKER_HOST',
  'KUBECONFIG',
]);

// Allowlist override via KC_ALLOW_ENV_VARS env var (comma-separated)
const ALLOWLISTED_ENV_VARS = new Set(
  (process.env.KC_ALLOW_ENV_VARS || '')
    .split(',')
    .map(v => v.trim().toUpperCase())
    .filter(Boolean)
);

function filterEnvVars(env: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {};
  const blockedVars: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    if (DANGEROUS_ENV_VARS.has(upperKey) && !ALLOWLISTED_ENV_VARS.has(upperKey)) {
      blockedVars.push(key);
      continue;
    }
    filtered[key] = value;
  }

  if (blockedVars.length > 0) {
    logger.tools.warn('Blocked dangerous environment variables', {
      blockedVars,
    });
  }

  return filtered;
}

const RunInputSchema = z.object({
  command: z.string().describe('Command to execute'),
  cwd: z.string().optional().describe('Working directory'),
  timeout: z.number().default(60).describe('Timeout in seconds'),
  env: z.record(z.string()).optional().describe('Environment variables'),
  shell: z.string().default('bash').describe('Shell to use'),
});

type RunInput = z.infer<typeof RunInputSchema>;

export const tool = buildTool<RunInput, string>({
  name: 'Run',
  description: 'Execute processes with enhanced control',

  inputSchema: RunInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const workingDir = input.cwd || context.cwd;
      const timeout = (Number.isFinite(input.timeout) ? input.timeout : 60) * 1000;

      const env = {
        ...process.env,
        ...filterEnvVars(input.env || {}),
      };

      // The ToolExecutor pre-wraps commands for 'Run' tool at the executor level
      // (the authoritative sandbox enforcement point). Check for the executor's
      // wrapping marker and HMAC signature to avoid double-wrapping.
      const inputRecord = input as Record<string, unknown>;
      const alreadyWrapped = isAlreadySandboxWrapped(inputRecord, 'Run');

      let wrappedCmd = input.command;
      let sandboxed = false;
      let sandboxBackend: string | undefined;

      if (alreadyWrapped) {
        // Executor already wrapped the command — use it directly
        sandboxed = context.sandbox?.isAvailable() ?? false;
        sandboxBackend = context.sandbox?.getBackendName();
      } else if (context.sandbox) {
        // Fallback: wrap via shared sandbox manager from ToolExecutor
        try {
          wrappedCmd = context.sandbox.wrapCommand(input.command, 'Run');
          sandboxed = context.sandbox.isAvailable();
          sandboxBackend = context.sandbox.getBackendName();
        } catch (_err) {
          logger.tools.error('Suppressed error: ' + String(_err));
          // Sandbox denied — should have been caught by ToolExecutor
          throw new Error('Run tool requires sandbox but sandbox is not available');
        }
      }

      const { stdout, stderr } = await execAsync(wrappedCmd, {
        cwd: workingDir,
        timeout,
        env,
        shell: input.shell,
        maxBuffer: LARGE_MAX_BUFFER,
      });

      const output = stdout || stderr;
      return toolResult(output, {
        metadata: {
          command: input.command,
          cwd: workingDir,
          exitCode: 0,
          sandboxed,
          sandboxBackend,
        },
      });
    } catch (error) {
      if (isExecError(error)) {
        const output = String(error.stdout || error.stderr || error.message || '').trim();
        return toolError(`Command failed: ${output}`, {
          command: input.command,
          exitCode: error.code,
        });
      }
      return toolError(`Command failed: ${getErrorMessage(error)}`, {
        command: input.command,
      });
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    // Block dangerous commands using shared pattern system
    for (const pattern of DANGEROUS_BASH_PATTERNS) {
      if (pattern.test(command)) {
        return {
          behavior: 'deny',
          message: `Dangerous command blocked: ${pattern.source}`,
        };
      }
    }

    return {
      behavior: 'ask',
      message: `Execute: ${input.command.slice(0, 100)}`,
    };
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,

  prompt: () => 'Execute processes with timeout and env control.',

  getToolUseSummary: (input) => `Running: ${input.command}`,
  getActivityDescription: (input) => `Executing process`,
});
