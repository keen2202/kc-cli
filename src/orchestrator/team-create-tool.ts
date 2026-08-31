// Team Create Tool - Lightweight entry: schema + metadata + permission check + delegating call.
// Heavy runtime (orchestrator, agent config factory) is deferred to team-create-impl.ts
// and loaded on first TeamCreate invocation via dynamic import.

import { z } from 'zod';
import { buildTool } from '../Tool.js';
import type { PermissionResult } from '../permissions/protocol.js';
import { listAgentTypes } from './agent-definitions.js';

const TeamAgentConfigSchema = z.object({
  name: z.string().describe('Unique name for this sub-agent'),
  agent_type: z
    .string()
    .optional()
    .describe(`Pre-defined agent type: ${listAgentTypes().join(', ')}`),
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

export type TeamCreateInput = z.infer<typeof TeamCreateInputSchema>;

export const tool = buildTool<TeamCreateInput, string>({
  name: 'TeamCreate',
  description:
    'Spawn multiple sub-agents in parallel for batch processing. Use wait_for_all=true to wait for completion.',

  inputSchema: TeamCreateInputSchema,

  call: async (input, context, onProgress) => {
    const { executeTeamCreate } = await import('./team-create-impl.js');
    return executeTeamCreate(input, context, onProgress);
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
