// Team Create Tool - Batch spawn multiple sub-agents

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../Tool.js';
import type { ToolResult as ToolResultType } from '../types/tools.js';
import type { PermissionResult } from '../types/permissions.js';
import { getOrchestrator } from './agent-orchestrator.js';
import { createAgentConfig } from './agent-definitions.js';
import type { ToolName } from '../types/tools.js';

const TeamAgentConfigSchema = z.object({
  name: z.string().describe('Unique name for this sub-agent'),
  agent_type: z
    .string()
    .optional()
    .describe('Pre-defined agent type: researcher, implementer, verifier, explorer, general'),
  prompt: z.string().describe('Task instruction for this agent'),
  tools_allow: z
    .array(z.string())
    .optional()
    .describe('Whitelist of allowed tool names'),
  tools_deny: z
    .array(z.string())
    .optional()
    .describe('Blacklist of denied tool names'),
  max_turns: z
    .number()
    .optional()
    .describe('Maximum number of LLM turns'),
  timeout: z
    .number()
    .optional()
    .describe('Timeout in seconds (default: 300)'),
});

const TeamCreateInputSchema = z.object({
  agents: z
    .array(TeamAgentConfigSchema)
    .describe('Array of agent configurations to spawn'),
  wait_for_all: z
    .boolean()
    .default(false)
    .describe('Wait for all agents to complete before returning'),
  timeout: z
    .number()
    .optional()
    .describe('Overall timeout for wait_for_all mode (seconds)'),
});

type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;

export const tool = buildTool<TeamCreateInput, string>({
  name: 'TeamCreate',
  description:
    'Spawn multiple sub-agents in parallel for batch processing. Use wait_for_all=true to wait for completion.',

  inputSchema: TeamCreateInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const orchestrator = getOrchestrator();
      const agentIds: string[] = [];
      const errors: string[] = [];

      // Spawn all agents
      for (const agentConfig of input.agents) {
        try {
          let spawnConfig;

          if (agentConfig.agent_type) {
            // Use pre-defined agent type
            spawnConfig = createAgentConfig(
              agentConfig.agent_type,
              agentConfig.prompt,
              {
                name: agentConfig.name,
                timeoutSeconds: agentConfig.timeout,
                maxTurns: agentConfig.max_turns,
                tools_allow: agentConfig.tools_allow as ToolName[] | undefined,
                tools_deny: agentConfig.tools_deny as ToolName[] | undefined,
              }
            );

            if (!spawnConfig) {
              errors.push(
                `${agentConfig.name}: Unknown agent type ${agentConfig.agent_type}`
              );
              continue;
            }
          } else {
            // Generic agent
            spawnConfig = {
              name: agentConfig.name,
              prompt: agentConfig.prompt,
              systemPromptMode: 'default' as const,
              timeoutSeconds: agentConfig.timeout,
              maxTurns: agentConfig.max_turns,
              tools: agentConfig.tools_allow as ToolName[] | undefined,
              deniedTools: agentConfig.tools_deny as ToolName[] | undefined,
            };
          }

          const agentId = await orchestrator.spawn(spawnConfig, context);
          agentIds.push(agentId);
        } catch (error) {
          errors.push(
            `${agentConfig.name}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      if (agentIds.length === 0) {
        return toolError(
          `Failed to spawn any agents. Errors:\n${errors.join('\n')}`
        );
      }

      if (!input.wait_for_all) {
        // Return immediately with agent IDs
        const outputLines = [
          `Team created: ${agentIds.length} agent(s) spawned\n`,
          `Agents:`,
          ...agentIds.map((id) => `  - ${id}`),
        ];

        if (errors.length > 0) {
          outputLines.push(`\nErrors (${errors.length}):`);
          errors.forEach((err) => outputLines.push(`  - ${err}`));
        }

        outputLines.push(
          `\nUse Agent tool with background=true to check individual status.`
        );

        return toolResult(outputLines.join('\n'), {
          metadata: {
            agent_ids: agentIds,
            total: agentIds.length,
            errors: errors.length,
            wait_for_all: false,
          },
        });
      }

      // Wait for all agents to complete
      const overallTimeoutMs = (input.timeout || 600) * 1000;
      const aggregatedResult = await orchestrator.waitForAll(overallTimeoutMs);

      // Format aggregated result
      const outputLines = [
        `Team execution completed\n`,
        `Agents: ${aggregatedResult.results.length}`,
        `Success: ${aggregatedResult.results.filter((r) => r.success).length}`,
        `Failed: ${aggregatedResult.results.filter((r) => !r.success).length}`,
        `Total tokens: ${aggregatedResult.totalTokensUsed.toLocaleString()}`,
        `Total time: ${(aggregatedResult.totalDuration / 1000).toFixed(1)}s\n`,
        `=== Individual Results ===\n`,
      ];

      for (const result of aggregatedResult.results) {
        const icon = result.success ? '✓' : '✗';
        outputLines.push(
          `[${result.name}] ${icon} (${result.success ? 'success' : `failed: ${result.error || 'unknown'}`})`
        );
        outputLines.push(
          `  Tools: ${result.toolUseCount}, Tokens: ${result.totalTokensUsed}, Time: ${(result.duration / 1000).toFixed(1)}s`
        );
        outputLines.push(`  Output: ${result.output.slice(0, 150)}...`);
        outputLines.push('');
      }

      outputLines.push(`\n${aggregatedResult.summary}`);

      return toolResult(outputLines.join('\n'), {
        metadata: {
          agent_ids: agentIds,
          total: aggregatedResult.results.length,
          success: aggregatedResult.results.filter((r) => r.success).length,
          failed: aggregatedResult.results.filter((r) => !r.success).length,
          total_tokens: aggregatedResult.totalTokensUsed,
          total_duration: aggregatedResult.totalDuration,
          wait_for_all: true,
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return toolError(`Team creation failed: ${errorMsg}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => ({
    behavior: 'ask',
    message: `Create team with ${input.agents.length} agent(s)`,
  }),

  isReadOnly: () => false,
  isConcurrencySafe: () => false, // Spawning multiple agents has side effects
  isDestructive: () => false,

  prompt: () =>
    'Spawn multiple sub-agents in parallel for batch processing.',

  getToolUseSummary: (input) =>
    `TeamCreate: ${input.agents.length} agent(s)`,
  getActivityDescription: (input) =>
    `Creating team of ${input.agents.length} agents`,
});
