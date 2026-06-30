// Pre-defined agent types for common tasks

import type { SubAgentSpawnConfig, AgentDefinition } from './types.js';
import type { ToolName } from '../tools/protocol.js';

/**
 * Built-in agent definitions for common task types
 */

const RESEARCHER_TOOLS: ToolName[] = [
  'FileRead',
  'Grep',
  'Glob',
  'Git',
  'WebSearch',
  'WebFetch',
  'Bash', // Read-only commands only
  'Monitor',
  'Config',
];

const IMPLEMENTER_TOOLS: ToolName[] = [
  'FileRead',
  'FileWrite',
  'FileEdit',
  'Bash',
  'Git',
  'Grep',
  'Glob',
  'Run',
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'Config',
];

const VERIFIER_TOOLS: ToolName[] = [
  'FileRead',
  'Bash',
  'Grep',
  'Glob',
  'Git',
  'TodoWrite',
  'Monitor',
  'Run',
];

const EXPLORER_TOOLS: ToolName[] = [
  'FileRead',
  'Grep',
  'Glob',
  'Bash',
  'Git',
  'Monitor',
  'Config',
  'TodoWrite',
];

/**
 * Built-in agent definitions
 */
export const BUILTIN_AGENT_DEFINITIONS: Record<string, AgentDefinition> = {
  researcher: {
    name: 'researcher',
    description:
      'Research assistant for code exploration. Read-only operations only, no file modifications.',
    systemPrompt:
      'You are a research assistant. Your task is to explore and understand code architecture. ' +
      'You can read files, search for patterns, and run read-only commands. ' +
      'DO NOT modify any files or make changes to the codebase. ' +
      'Provide detailed findings and insights.',
    allowedTools: RESEARCHER_TOOLS,
    toolRestrictions: [
      { toolName: 'Bash', restrictions: { readOnly: true } },
    ],
    defaultMaxTurns: 30,
    defaultTimeoutSeconds: 300,
  },

  implementer: {
    name: 'implementer',
    description:
      'Implementation engineer for writing code and making changes to the codebase.',
    systemPrompt:
      'You are an implementation engineer. Your task is to write code and implement features. ' +
      'Follow best practices, write clean code, and ensure your changes are correct. ' +
      'Test your changes when possible. Provide a summary of changes made.',
    allowedTools: IMPLEMENTER_TOOLS,
    defaultMaxTurns: 50,
    defaultTimeoutSeconds: 600,
  },

  verifier: {
    name: 'verifier',
    description:
      'Verification expert for testing and code review.',
    systemPrompt:
      'You are a verification expert. Your task is to test code changes and review code quality. ' +
      'Run tests, check for bugs, verify correctness, and identify issues. ' +
      'Provide detailed verification results and recommendations.',
    allowedTools: VERIFIER_TOOLS,
    defaultMaxTurns: 25,
    defaultTimeoutSeconds: 300,
  },

  explorer: {
    name: 'explorer',
    description:
      'Codebase explorer for understanding project structure and architecture.',
    systemPrompt:
      'You are a codebase explorer. Your task is to understand the project structure, ' +
      'architecture, and key components. Map out the codebase, identify main modules, ' +
      'and document relationships. Provide a comprehensive overview.',
    allowedTools: EXPLORER_TOOLS,
    defaultMaxTurns: 20,
    defaultTimeoutSeconds: 300,
  },

  general: {
    name: 'general',
    description: 'General-purpose agent with access to all tools.',
    allowedTools: undefined, // All tools
    defaultMaxTurns: 40,
    defaultTimeoutSeconds: 300,
  },
};

/**
 * Get a pre-defined agent configuration
 *
 * @param type - Agent type (researcher, implementer, verifier, explorer, general)
 * @returns Agent definition or null if not found
 */
export function getAgentDefinition(type: string): AgentDefinition | null {
  return BUILTIN_AGENT_DEFINITIONS[type] || null;
}

/**
 * List all available agent types
 */
export function listAgentTypes(): string[] {
  return Object.keys(BUILTIN_AGENT_DEFINITIONS);
}

/**
 * Merge user config with agent definition
 *
 * @param type - Agent type
 * @param userPrompt - User's task instruction
 * @param overrides - Optional config overrides
 * @returns Complete spawn configuration
 */
export function createAgentConfig(
  type: string,
  userPrompt: string,
  overrides?: Partial<SubAgentSpawnConfig>
): SubAgentSpawnConfig | null {
  const def = getAgentDefinition(type);
  if (!def) {
    return null;
  }

  return {
    name: overrides?.name || `${type}-${Date.now()}`,
    prompt: userPrompt,
    systemPrompt: def.systemPrompt,
    systemPromptMode: overrides?.systemPromptMode || 'default',
    tools: overrides?.tools || def.allowedTools,
    deniedTools: overrides?.deniedTools,
    maxTurns: overrides?.maxTurns || def.defaultMaxTurns,
    timeoutSeconds: overrides?.timeoutSeconds || def.defaultTimeoutSeconds,
    tokenBudget: overrides?.tokenBudget,
    model: overrides?.model,
    permissions: overrides?.permissions,
    cwd: overrides?.cwd,
  };
}
