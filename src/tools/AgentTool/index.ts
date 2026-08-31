// Agent Tool - Lightweight entry: schema + metadata + permission check + delegating call.
// Heavy runtime (orchestrator, agent config factory, tool registry) is deferred to impl.ts
// and loaded on first Agent invocation via dynamic import.

import { z } from 'zod';
import { buildTool } from '../../Tool';
import type { PermissionResult } from '../../permissions/protocol';

// Static metadata only. The runtime list remains available in impl.ts for
// validation error messages; this entry must not import the orchestrator at
// startup (Task 1.7).
const AGENT_TYPE_LIST =
  'researcher, implementer, verifier, explorer, general, frontend, backend, fullstack, code-reviewer, tester, architect, product-manager';

const AgentInputSchema = z.object({
  prompt: z.string().describe('Instructions for the sub-agent'),
  description: z.string().optional().describe('Brief description of the task'),
  timeout: z.number().default(300).describe('Timeout in seconds'),
  agent_type: z
    .string()
    .optional()
    .describe(`Pre-defined agent type: ${AGENT_TYPE_LIST}`),
  background: z
    .boolean()
    .default(false)
    .describe('Run in background (return immediately with agent ID)'),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

export const tool = buildTool<AgentInput, string>({
  name: 'Agent',
  description:
    'Spawn sub-agents for parallel task execution. Use agent_type for pre-configured specialists ' +
    `(${AGENT_TYPE_LIST}).`,

  inputSchema: AgentInputSchema,

  call: async (input, context, onProgress) => {
    const { executeAgent } = await import('./impl.js');
    return executeAgent(input, context, onProgress);
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
