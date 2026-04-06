// Agent Tool - Spawn sub-agents for parallel work
// NOTE: Multi-agent coordination framework is implemented in src/orchestrator/
// but has TypeScript compilation issues on Windows ESM. The framework is ready
// and can be enabled once type errors are resolved.

import { z } from 'zod';
import { buildTool, toolResult, toolError } from '../../Tool';
import type { ToolResult as ToolResultType } from '../../types/tools';
import type { PermissionResult } from '../../types/permissions';

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
      // TODO: Enable multi-agent coordination once TypeScript ESM issues are resolved
      // The full implementation is in src/orchestrator/:
      // - agent-orchestrator.ts - Central coordinator
      // - event-bus.ts - In-memory pub/sub
      // - permission-cascader.ts - Permission inheritance
      // - result-aggregator.ts - Result collection
      // - backends/in-process.ts - AsyncLocalStorage isolation
      // - agent-definitions.ts - Pre-defined agent types

      return toolResult(
        `Sub-agent spawned (simulated - multi-agent framework ready, awaiting TS fix)\n\n` +
        `Task: ${input.description || input.prompt.slice(0, 100)}\n` +
        `Agent Type: ${input.agent_type || 'general'}\n` +
        `Prompt length: ${input.prompt.length} chars\n` +
        `Timeout: ${input.timeout}s\n\n` +
        `Multi-agent coordination framework is implemented in src/orchestrator/.\n` +
        `Once TypeScript ESM path issues are resolved, this will:\n` +
        `1. Create isolated QueryEngine instance\n` +
        `2. Apply permission cascading (child <= parent)\n` +
        `3. Run agent loop with EventBus forwarding\n` +
        `4. Collect and format results`,
        {
          metadata: {
            prompt_length: input.prompt.length,
            timeout: input.timeout,
            agent_type: input.agent_type || 'general',
            simulated: true,
            framework_ready: true,
          },
        }
      );
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
