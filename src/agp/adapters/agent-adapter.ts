/**
 * AGP Agent Adapter
 *
 * Converts kc-cli's pre-defined AgentDefinition objects into AGP
 * ResourceRegistrationRecord<'Agent'> format.
 *
 * The built-in agents (researcher, implementer, verifier, explorer, general,
 * plus the specialized role agents such as frontend, backend, architect)
 * become first-class evolvable RSPL resources.
 */

import type { AgentDefinition } from '../../orchestrator/protocol';
import { BUILTIN_AGENT_DEFINITIONS } from '../../orchestrator/agent-definitions';
import type { ResourceRegistrationRecord, ResourceEntity, AgentMetadata, ExportedRepresentation } from '../protocol';
import { createResourceEntity, createRegistrationRecord, createTextRep } from '../types';

// ─── AgentDefinition → RSPL Record ──────────────────────────────────────────

/**
 * Convert an AgentDefinition to an AGP ResourceRegistrationRecord.
 */
export function agentToRecord(agent: AgentDefinition): ResourceRegistrationRecord<'Agent'> {
  const metadata: AgentMetadata = {
    systemPrompt: agent.systemPrompt,
    allowedTools: agent.allowedTools as string[] | undefined,
    deniedTools: agent.deniedTools as string[] | undefined,
    defaultMaxTurns: agent.defaultMaxTurns,
    role: agent.description,
  };

  const entity: ResourceEntity<'Agent'> = createResourceEntity('Agent', agent.name, agent.description, {
    evolvability: 1, // Agents are evolvable by default
    ioMapping: {
      inputSchema: { type: 'object', properties: { task: { type: 'string' } } },
      outputSchema: { type: 'object', properties: { result: { type: 'string' } } },
    },
    metadata,
  });

  const exportedRepresentations: ExportedRepresentation[] = [
    createTextRep(
      `Agent: ${agent.name}\nRole: ${agent.description}\nTools: ${agent.allowedTools?.join(', ') ?? 'all'}`,
      `agent:${agent.name}`
    ),
  ];

  return createRegistrationRecord(entity, {
    version: '1.0.0',
    implementationDescriptor: `orchestrator/agents/${agent.name}`,
    instantiationParams: {
      defaultTimeoutSeconds: agent.defaultTimeoutSeconds,
      systemPromptMode: 'default',
    },
    exportedRepresentations,
  });
}

// ─── RSPL Record → AgentDefinition ──────────────────────────────────────────

/**
 * Reconstruct an AgentDefinition from an AGP record.
 * Used when an agent has been evolved and needs to be re-instantiated.
 */
export function recordToAgent(record: ResourceRegistrationRecord<'Agent'>): AgentDefinition {
  const metadata = record.entity.metadata as AgentMetadata;

  return {
    name: record.entity.name,
    description: record.entity.description,
    systemPrompt: metadata.systemPrompt,
    allowedTools: metadata.allowedTools as any,
    deniedTools: metadata.deniedTools as any,
    defaultMaxTurns: metadata.defaultMaxTurns,
  };
}

// ─── Built-in Agent Definitions ──────────────────────────────────────────────

/**
 * Create RSPL records for all built-in kc-cli agent types.
 * Derived from the orchestrator's BUILTIN_AGENT_DEFINITIONS so newly added
 * agent roles automatically become evolvable resources.
 */
export function createBuiltInAgentRecords(): ResourceRegistrationRecord<'Agent'>[] {
  return Object.values(BUILTIN_AGENT_DEFINITIONS).map(agentToRecord);
}
