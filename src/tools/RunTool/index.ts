// Run Tool - Execute processes/commands with enhanced control

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { isAlreadySandboxWrapped } from '../../executors/toolExecutor';
import { getErrorMessage } from '../../utils/errors';
import { isDangerousBashCommand } from '../../permissions/readonlyCommands';
import { logger } from '../../services/logger';
import { filterEnvVars } from './secrets';
import {
  detectUnixFindOnWindows,
  getWindowsCommandHint,
  isCommandNotFoundOutput,
} from '../BashTool/windows-compat';

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

      // Windows guard: Unix `find` syntax resolves to FIND.EXE under cmd.exe
      // and fails with a cryptic error — fail fast with actionable guidance.
      const findIncompat = detectUnixFindOnWindows(input.command);
      if (findIncompat) {
        return toolError(`[tool_execution_failed] Command not executed: ${findIncompat}`, {
          command: input.command,
          platform: process.platform,
        });
      }

      // Filter KC_* secrets and dangerous vars from parent env (SEC-03)
      const env = {
        ...filterEnvVars(Object.fromEntries(
          Object.entries(process.env).filter(([, v]) => v !== undefined)
        ) as Record<string, string>),
        ...filterEnvVars(input.env || {}),
      } as Record<string, string>;

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

      const result = await context.env.shell.exec(wrappedCmd, {
        cwd: workingDir,
        timeout,
        env,
        signal: context.abortController?.signal,
      });

      if (result.exitCode !== 0) {
        const output = (result.stdout || result.stderr || '').trim();
        const winHint = isCommandNotFoundOutput(output)
          ? getWindowsCommandHint(input.command)
          : null;
        return toolError(`Command failed (exit ${result.exitCode}): ${output}${winHint ? `\n${winHint}` : ''}`, {
          command: input.command,
          exitCode: result.exitCode,
        });
      }

      const output = result.stdout || result.stderr;
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
      return toolError(`Command failed: ${getErrorMessage(error)}`, {
        command: input.command,
      });
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    const command = input.command.trim();

    // Block dangerous commands (bypass-resistant: handles var/$(...)/base64/|sh)
    if (isDangerousBashCommand(command)) {
      return {
        behavior: 'deny',
        message: `Dangerous command blocked: ${command}`,
      };
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
