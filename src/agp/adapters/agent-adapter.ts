/**
 * AGP Agent Adapter
 *
 * Converts kc-cli's pre-defined AgentDefinition objects into AGP
 * ResourceRegistrationRecord<'Agent'> format.
 *
 * The built-in agents (researcher, implementer, verifier, explorer, general)
 * become first-class evolvable RSPL resources.
 */

import type { AgentDefinition } from '../../orchestrator/protocol';
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
 */
export function createBuiltInAgentRecords(): ResourceRegistrationRecord<'Agent'>[] {
  const builtInAgents: AgentDefinition[] = [
    {
      name: 'researcher',
      description: 'Research assistant that gathers information and analyzes findings',
      systemPrompt: 'You are a research assistant. Your job is to thoroughly investigate topics, gather relevant information from multiple sources, and provide comprehensive analysis.',
      defaultMaxTurns: 20,
    },
    {
      name: 'implementer',
      description: 'Code implementation specialist that writes and modifies source code',
      systemPrompt: 'You are an implementation specialist. Write clean, well-tested code following best practices. Always consider edge cases and error handling.',
      defaultMaxTurns: 25,
    },
    {
      name: 'verifier',
      description: 'Quality assurance agent that validates implementations and runs tests',
      systemPrompt: 'You are a QA specialist. Verify that implementations are correct by running tests, checking edge cases, and validating against requirements.',
      defaultMaxTurns: 15,
    },
    {
      name: 'explorer',
      description: 'Codebase explorer that navigates and understands project structure',
      systemPrompt: 'You are a codebase explorer. Navigate project structures, understand architecture, and provide clear summaries of code organization and dependencies.',
      defaultMaxTurns: 15,
    },
    {
      name: 'general',
      description: 'General-purpose agent for miscellaneous tasks',
      systemPrompt: 'You are a general-purpose assistant. Help with any software development task using available tools.',
      defaultMaxTurns: 20,
    },
  ];

  return builtInAgents.map(agentToRecord);
}
