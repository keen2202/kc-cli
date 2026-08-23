// Run Tool - Execute processes/commands with enhanced control

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { getErrorMessage } from '../../utils/errors';
import { logger } from '../../services/logger';
import { filterEnvVars } from './secrets';
import {
  applySandboxPreWrap,
  checkDangerousCommand,
  guardsWindowsFind,
  handleNonZeroExit,
} from '../shared/command-execution';

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
      const findGuard = guardsWindowsFind(input.command, process.platform);
      if (findGuard.blocked) {
        return toolError(findGuard.errorMessage, {
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
      // (the authoritative sandbox enforcement point). Shared helper verifies the
      // executor's wrapping marker + HMAC signature to avoid double-wrapping and
      // falls back to wrapping via the shared sandbox manager.
      const wrap = applySandboxPreWrap({
        command: input.command,
        toolName: 'Run',
        input: input as Record<string, unknown>,
        sandbox: context.sandbox,
        onWrapError: (err) => logger.tools.error('Suppressed error: ' + String(err)),
      });

      const result = await context.env.shell.exec(wrap.wrappedCmd, {
        cwd: workingDir,
        timeout,
        env,
        signal: context.abortController?.signal,
      });

      if (result.exitCode !== 0) {
        const output = (result.stdout || result.stderr || '').trim();
        const failure = handleNonZeroExit({
          exitCode: result.exitCode,
          command: input.command,
          scanText: output,
          detail: output,
          platform: process.platform,
        });
        return toolError(failure.message, {
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
          sandboxed: wrap.sandboxed,
          sandboxBackend: wrap.sandboxBackend,
        },
      });
    } catch (error) {
      return toolError(`Command failed: ${getErrorMessage(error)}`, {
        command: input.command,
      });
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    // Block dangerous commands (bypass-resistant: handles var/$(...)/base64/|sh)
    const dangerousVerdict = checkDangerousCommand(input.command);
    if (dangerousVerdict.dangerous) {
      return {
        behavior: 'deny',
        message: `Dangerous command blocked: ${dangerousVerdict.classifiedCommand}`,
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
