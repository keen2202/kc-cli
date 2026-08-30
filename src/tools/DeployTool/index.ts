// Deploy Tool - Deploy applications to various environments

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../protocol';
import type { PermissionResult } from '../../permissions/protocol';
import { getErrorMessage } from '../../utils/errors';

const DeployInputSchema = z.object({
  target: z.enum(['local', 'docker', 'vercel', 'netlify', 'ssh', 'custom']).describe('Deployment target'),
  command: z.string().optional().describe('Custom deploy command (for custom target)'),
  environment: z.enum(['development', 'staging', 'production']).default('production').describe('Target environment'),
  dry_run: z.boolean().default(false).describe('Preview deployment without executing'),
});

type DeployInput = z.infer<typeof DeployInputSchema>;

export const tool = buildTool<DeployInput, string>({
  name: 'Deploy',
  description: 'Deploy applications to various environments',

  inputSchema: DeployInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      if (input.dry_run) {
        return toolResult(
          `Dry run - would deploy to:\n` +
          `Target: ${input.target}\n` +
          `Environment: ${input.environment}\n` +
          `Command: ${input.command || getDefaultDeployCommand(input.target)}`,
          {
            metadata: {
              target: input.target,
              environment: input.environment,
              dry_run: true,
            },
          }
        );
      }

      // Get deployment command
      const command = input.command || getDefaultDeployCommand(input.target);

      // Execute deployment via ExecutionEnv abstraction
      const result = await context.env.shell.exec(command, {
        cwd: context.cwd,
        timeout: 600_000,
      });

      return toolResult(
        `Deployed to ${input.target} (${input.environment})\n\n` +
        (result.stdout || result.stderr || 'Deployment completed successfully.'),
        {
          metadata: {
            target: input.target,
            environment: input.environment,
            success: true,
          },
        }
      );
    } catch (error) {
      return toolError(`Deploy failed: ${getErrorMessage(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => {
    if (input.dry_run) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: { type: 'readonly', reason: 'Dry run is read-only' },
      };
    }

    return {
      behavior: 'ask',
      message: `Deploy to ${input.target} (${input.environment})`,
    };
  },

  isReadOnly: (input) => input.dry_run,
  isConcurrencySafe: () => false,
  isDestructive: (input) => !input.dry_run,

  prompt: () => 'Deploy apps (local, Docker, Vercel, etc). Supports dry run.',

  getToolUseSummary: (input) =>
    input.dry_run
      ? `Dry run deploy: ${input.target}`
      : `Deploying to ${input.target}`,
  getActivityDescription: (input) =>
    input.dry_run
      ? `Previewing deployment to ${input.target}`
      : `Deploying to ${input.target}`,
});

function getDefaultDeployCommand(target: string): string {
  switch (target) {
    case 'local':
      return 'npm run start';
    case 'docker':
      return 'docker compose up -d --build';
    case 'vercel':
      return 'vercel --prod';
    case 'netlify':
      return 'netlify deploy --prod';
    case 'ssh':
      return 'echo "No SSH target configured. Provide a custom deploy command." '; // M9b: CC_DEPLOY_SSH_TARGET was never read anywhere
    case 'custom':
      return 'echo "No custom command specified"';
    default:
      return 'echo "Unknown target"';
  }
}
