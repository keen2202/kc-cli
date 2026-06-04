/**
 * AGP Prompt Adapter
 *
 * Converts system prompts and prompt templates into AGP
 * ResourceRegistrationRecord<'Prompt'> format.
 *
 * Unifies the scattered prompt logic across kc-cli into
 * first-class evolvable AGP resources.
 */

import type { ResourceRegistrationRecord, ResourceEntity, PromptMetadata, ExportedRepresentation } from '../protocol';
import { createResourceEntity, createRegistrationRecord, createTextRep } from '../types';

// ─── Prompt Resource Creation ─────────────────────────────────────────────────

export interface PromptResourceInput {
  /** Unique prompt name */
  name: string;
  /** Description of the prompt's purpose */
  description: string;
  /** The prompt template text */
  template: string;
  /** Whether this prompt can be evolved by SEPL (default: 1) */
  evolvability?: 0 | 1;
  /** Template variable names (e.g., ['tools', 'context']) */
  templateVariables?: string[];
  /** Role/purpose label */
  role?: string;
  /** Version string */
  version?: string;
}

/**
 * Create a Prompt RSPL registration record.
 */
export function createPromptRecord(input: PromptResourceInput): ResourceRegistrationRecord<'Prompt'> {
  const metadata: PromptMetadata = {
    template: input.template,
    role: input.role ?? 'system',
    templateVariables: input.templateVariables ?? [],
  };

  const entity: ResourceEntity<'Prompt'> = createResourceEntity('Prompt', input.name, input.description, {
    evolvability: input.evolvability ?? 1, // Prompts are evolvable by default
    ioMapping: {
      inputSchema: { type: 'object', properties: { context: { type: 'string' } } },
      outputSchema: { type: 'string' },
    },
    metadata,
  });

  const exportedRepresentations: ExportedRepresentation[] = [
    createTextRep(input.template, `prompt:${input.name}`),
  ];

  return createRegistrationRecord(entity, {
    version: input.version ?? '1.0.0',
    implementationDescriptor: `prompts/${input.name}`,
    instantiationParams: {
      role: metadata.role,
      templateVariables: metadata.templateVariables,
    },
    exportedRepresentations,
  });
}

// ─── Prompt Record → Template ────────────────────────────────────────────────

/**
 * Extract the template text from a Prompt resource record.
 */
export function getPromptTemplate(record: ResourceRegistrationRecord<'Prompt'>): string {
  const metadata = record.entity.metadata as PromptMetadata;
  return metadata.template ?? record.entity.description;
}

/**
 * Render a prompt template by substituting variables.
 * Uses simple {{variable}} replacement.
 */
export function renderPromptTemplate(
  record: ResourceRegistrationRecord<'Prompt'>,
  variables: Record<string, string>
): string {
  let template = getPromptTemplate(record);

  for (const [key, value] of Object.entries(variables)) {
    template = template.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }

  return template;
}

/**
 * Apply evolved prompt text back to a Prompt resource record.
 * Returns a new record with the updated template.
 */
export function applyEvolvedPrompt(
  record: ResourceRegistrationRecord<'Prompt'>,
  newTemplate: string
): ResourceRegistrationRecord<'Prompt'> {
  const updatedMetadata: PromptMetadata = {
    ...(record.entity.metadata as PromptMetadata),
    template: newTemplate,
  };

  return {
    ...record,
    entity: {
      ...record.entity,
      metadata: updatedMetadata,
    },
    exportedRepresentations: [
      createTextRep(newTemplate, `prompt:${record.entity.name}`),
    ],
  };
}

// ─── Default System Prompts ──────────────────────────────────────────────────

/**
 * Create the default KC-CLI system prompt as an AGP Prompt resource.
 */
export function createDefaultSystemPrompt(toolNames: string[]): ResourceRegistrationRecord<'Prompt'> {
  const template = `You are KC-CLI, an intelligent CLI agent that helps with software development tasks.

You have access to the following tools: {{tools}}

Guidelines:
1. Always think step-by-step before taking action
2. Use tools to gather information before making changes
3. Be careful with destructive operations
4. Explain what you're doing and why
5. Ask for clarification when needed
6. Follow best practices for code quality and security

Available capabilities:
- Read, write, and edit files
- Execute bash commands
- Search code and files
- Git operations
- Web search and fetch
- Database queries
- Docker operations
- Application deployment
- System monitoring
- Compile, test, and run programs

Always work methodically and keep the user informed of your progress.`;

  return createPromptRecord({
    name: 'system-prompt-default',
    description: 'Default KC-CLI system prompt with tool listing and behavioral guidelines',
    template,
    evolvability: 1,
    templateVariables: ['tools'],
    role: 'system',
  });
}

/**
 * Create a beginner-level system prompt variant.
 */
export function createBeginnerSystemPrompt(): ResourceRegistrationRecord<'Prompt'> {
  return createPromptRecord({
    name: 'system-prompt-beginner',
    description: 'System prompt variant for beginner-level users with extra guidance',
    template: `You are KC-CLI, a helpful CLI agent. The user is a beginner developer.
Please provide extra explanations and step-by-step guidance.
Always explain WHY you are doing something before doing it.
When using tools, describe what each tool does in simple terms.

Available tools: {{tools}}`,
    evolvability: 1,
    templateVariables: ['tools'],
    role: 'system',
  });
}

/**
 * Create an advanced-level system prompt variant.
 */
export function createAdvancedSystemPrompt(): ResourceRegistrationRecord<'Prompt'> {
  return createPromptRecord({
    name: 'system-prompt-advanced',
    description: 'System prompt variant for advanced users with minimal guidance',
    template: `You are KC-CLI, an expert CLI agent. The user is an advanced developer.
Be concise. Prefer action over explanation unless asked.
Use tools efficiently and in parallel when possible.

Available tools: {{tools}}`,
    evolvability: 1,
    templateVariables: ['tools'],
    role: 'system',
  });
}
