// Agent Tool - Spawn sub-agents for parallel work via the orchestrator

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';
import type { SubAgentSpawnConfig } from '../../orchestrator/types';
import { getOrchestrator } from '../../orchestrator/agent-orchestrator.js';
import { createAgentConfig } from '../../orchestrator/agent-definitions.js';
import { toolRegistry } from '../../tools.js';
import { secondsToMs } from '../../utils/timeout';

const AgentInputSchema = z.object({
  prompt: z.string().describe('Instructions for the sub-agent'),
  description: z.string().optional().describe('Brief description of the task'),
  timeout: z.number().default(300).describe('Timeout in seconds'),
  agent_type: z
    .string()
    .optional()
    .describe('Pre-defined agent type: researcher, implementer, verifier, explorer, general'),
  background: z
    .boolean()
    .default(false)
    .describe('Run in background (return immediately with agent ID)'),
});

type AgentInput = z.infer<typeof AgentInputSchema>;

export const tool = buildTool<AgentInput, string>({
  name: 'Agent',
  description:
    'Spawn sub-agents for parallel task execution. Use agent_type for pre-configured specialists (researcher, implementer, verifier, explorer).',

  inputSchema: AgentInputSchema,

  call: async (input, context): Promise<ToolResultType<string>> => {
    try {
      const tools = toolRegistry.getAllTools();
      const orchestrator = getOrchestrator(tools);

      let config: SubAgentSpawnConfig;

      if (input.agent_type) {
        const agentConfig = createAgentConfig(input.agent_type, input.prompt, {
          timeoutSeconds: input.timeout,
        });
        if (!agentConfig) {
          return toolError(
            `Unknown agent type: ${input.agent_type}. Available types: researcher, implementer, verifier, explorer, general`
          );
        }
        config = agentConfig;
      } else {
        config = {
          name: input.description || `agent-${Date.now()}`,
          prompt: input.prompt,
          systemPromptMode: 'default',
          timeoutSeconds: input.timeout,
        };
      }

      const agentId = await orchestrator.spawn(config, context);

      // If background mode, return immediately with the agent ID
      if (input.background) {
        return toolResult(
          `Sub-agent spawned in background.\nAgent ID: ${agentId}\nTask: ${input.description || input.prompt.slice(0, 100)}`,
          {
            metadata: {
              agent_id: agentId,
              agent_type: input.agent_type || 'general',
              background: true,
              status: 'running',
            },
          }
        );
      }

      // Wait for the sub-agent to complete
      const result = await orchestrator.waitForCompletion(
        agentId,
        secondsToMs(input.timeout, 300_000)
      );

      return toolResult(result.output, {
        metadata: {
          agent_id: agentId,
          agent_type: input.agent_type || 'general',
          success: result.success,
          duration_ms: result.duration,
          tool_use_count: result.toolUseCount,
          total_tokens_used: result.totalTokensUsed,
        },
      });
    } catch (error) {
      return toolError(`Agent spawn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  },

  checkPermissions: (input, context): PermissionResult => ({
    behavior: 'ask',
    message: `Spawn sub-agent: ${input.description || input.prompt.slice(0, 50)}...`,
  }),

  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isDestructive: () => false,

  prompt: () =>
    'Spawn sub-agents for parallel work. Use agent_type for pre-configured specialists.',

  getToolUseSummary: (input) =>
    `Agent: ${input.description || input.prompt.slice(0, 50)}...`,
  getActivityDescription: (input) =>
    `Spawning sub-agent: ${input.agent_type || 'general'}`,
});
