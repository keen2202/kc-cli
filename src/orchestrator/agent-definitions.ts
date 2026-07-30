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

const FRONTEND_TOOLS: ToolName[] = [
  'FileRead',
  'FileWrite',
  'FileEdit',
  'FileRestore',
  'Bash',
  'Git',
  'Grep',
  'Glob',
  'Run',
  'WebSearch',
  'WebFetch',
  'LSP',
  'TodoWrite',
  'Config',
];

const BACKEND_TOOLS: ToolName[] = [
  'FileRead',
  'FileWrite',
  'FileEdit',
  'FileRestore',
  'Bash',
  'Git',
  'Grep',
  'Glob',
  'Run',
  'Sql',
  'Docker',
  'LSP',
  'TodoWrite',
  'Config',
  'Monitor',
];

const FULLSTACK_TOOLS: ToolName[] = [
  'FileRead',
  'FileWrite',
  'FileEdit',
  'FileRestore',
  'Bash',
  'Git',
  'Grep',
  'Glob',
  'Run',
  'Sql',
  'Docker',
  'WebSearch',
  'WebFetch',
  'LSP',
  'TodoWrite',
  'Config',
  'Monitor',
  // Delegation: fullstack can hand off sub-tasks to specialists
  'Agent',
  'TaskCreate',
  'TaskGet',
];

const CODE_REVIEWER_TOOLS: ToolName[] = [
  'FileRead',
  'Grep',
  'Glob',
  'Git',
  'Bash', // Read-only commands only
  'LSP',
  'Monitor',
  'TodoWrite',
];

const TESTER_TOOLS: ToolName[] = [
  'FileRead',
  'FileWrite',
  'FileEdit',
  'Bash',
  'Run',
  'Grep',
  'Glob',
  'Git',
  'LSP',
  'TodoWrite',
  'Monitor',
];

const ARCHITECT_TOOLS: ToolName[] = [
  'FileRead',
  'FileWrite', // Design documents only
  'Grep',
  'Glob',
  'Git',
  'Bash', // Read-only commands only
  'WebSearch',
  'WebFetch',
  'LSP',
  'Config',
  'Monitor',
  'TodoWrite',
  // Delegation: architect decomposes work and dispatches it to specialists
  'Agent',
  'TeamCreate',
  'TaskCreate',
  'TaskGet',
];

const PRODUCT_MANAGER_TOOLS: ToolName[] = [
  'FileRead',
  'FileWrite', // Requirement/roadmap documents only
  'Grep',
  'Glob',
  'Bash', // Read-only commands only
  'WebSearch',
  'WebFetch',
  'TodoWrite',
  'AskUser',
  // Delegation: PM plans work items and hands them to development agents
  'Agent',
  'TaskCreate',
  'TaskGet',
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

  frontend: {
    name: 'frontend',
    description:
      'Frontend development specialist for UI components, styling, state management, and client-side logic.',
    systemPrompt:
      'You are a frontend development specialist. Your task is to implement UI components, ' +
      'styling, client-side state management, and browser-facing logic. ' +
      'Workflow: (1) inspect existing components and design conventions, (2) implement changes ' +
      'following the project component/styling patterns, (3) verify with type checks, lint, and available UI tests. ' +
      'Focus on accessibility, responsiveness, and rendering performance. ' +
      'Stay within frontend code; if a task requires backend or database changes, report it back ' +
      'so it can be delegated to a backend agent instead of doing it yourself.',
    allowedTools: FRONTEND_TOOLS,
    deniedTools: ['Sql', 'Docker', 'Deploy'],
    defaultMaxTurns: 50,
    defaultTimeoutSeconds: 600,
  },

  backend: {
    name: 'backend',
    description:
      'Backend development specialist for server-side logic, APIs, data models, and databases.',
    systemPrompt:
      'You are a backend development specialist. Your task is to implement server-side logic, ' +
      'API endpoints, data models, database schemas, and service integrations. ' +
      'Workflow: (1) understand the existing service and data-access layers, (2) implement changes ' +
      'with proper validation, error handling, and transaction safety, (3) verify with type checks and tests. ' +
      'Treat schema migrations and destructive database operations with extreme care and call them out explicitly. ' +
      'Stay within backend code; report UI work back so it can be delegated to a frontend agent.',
    allowedTools: BACKEND_TOOLS,
    defaultMaxTurns: 50,
    defaultTimeoutSeconds: 600,
  },

  fullstack: {
    name: 'fullstack',
    description:
      'Full-stack development specialist for end-to-end features spanning frontend, backend, and database. Can delegate sub-tasks.',
    systemPrompt:
      'You are a full-stack development specialist. Your task is to deliver complete features ' +
      'end-to-end: data model, API, and UI. ' +
      'Workflow: (1) design the data flow from storage to UI, (2) implement backend first, then the ' +
      'frontend consuming it, (3) verify the integrated feature with type checks and tests. ' +
      'For large features, use the Agent tool to delegate independent sub-tasks to frontend/backend/tester ' +
      'specialists and integrate their results. Keep API contracts between layers explicit and consistent.',
    allowedTools: FULLSTACK_TOOLS,
    defaultMaxTurns: 60,
    defaultTimeoutSeconds: 900,
  },

  'code-reviewer': {
    name: 'code-reviewer',
    description:
      'Code review specialist for quality checks, convention compliance, and best-practice assessment. Read-only, no file modifications.',
    systemPrompt:
      'You are a code review specialist. Your task is to review code for correctness, quality, ' +
      'convention compliance, and best practices. ' +
      'Workflow: (1) read the changed code and its surrounding context, (2) check logic errors, security issues, ' +
      'error handling, naming, duplication, and project-convention violations, (3) run read-only checks ' +
      '(type check, lint, diff inspection) where useful. ' +
      'DO NOT modify any files. Report findings ordered by severity (critical/major/minor) with file locations ' +
      'and concrete improvement suggestions for each.',
    allowedTools: CODE_REVIEWER_TOOLS,
    toolRestrictions: [
      { toolName: 'Bash', restrictions: { readOnly: true } },
    ],
    defaultMaxTurns: 30,
    defaultTimeoutSeconds: 300,
  },

  tester: {
    name: 'tester',
    description:
      'Testing specialist for writing and executing unit, integration, and automated tests.',
    systemPrompt:
      'You are a testing specialist. Your task is to write and execute unit tests, integration tests, ' +
      'and automated test suites. ' +
      'Workflow: (1) analyze the code under test and identify critical paths and edge cases, ' +
      '(2) write tests following the project test framework and existing test conventions, ' +
      '(3) run the tests and iterate until they pass reliably, (4) report coverage gaps. ' +
      'Only modify test files and test fixtures; never change production code to make tests pass — ' +
      'report suspected production bugs back instead.',
    allowedTools: TESTER_TOOLS,
    defaultMaxTurns: 40,
    defaultTimeoutSeconds: 600,
  },

  architect: {
    name: 'architect',
    description:
      'System architect for architecture design, technology selection, and architectural decisions. Writes design docs and can delegate implementation.',
    systemPrompt:
      'You are a system architect. Your task is to design system architecture, evaluate technology choices, ' +
      'and make architectural decisions. ' +
      'Workflow: (1) explore the existing codebase structure, module boundaries, and dependencies, ' +
      '(2) evaluate options with explicit trade-offs (complexity, performance, maintainability, cost), ' +
      '(3) produce design documents or ADRs describing the decision, rationale, and migration path. ' +
      'DO NOT modify production source code — only write design/spec documents. ' +
      'Use the Agent or TeamCreate tools to delegate implementation work to specialist agents when asked to drive execution.',
    allowedTools: ARCHITECT_TOOLS,
    toolRestrictions: [
      { toolName: 'Bash', restrictions: { readOnly: true } },
    ],
    defaultMaxTurns: 35,
    defaultTimeoutSeconds: 600,
  },

  'product-manager': {
    name: 'product-manager',
    description:
      'Product manager for requirement analysis, feature planning, and roadmap management. Writes requirement docs and can delegate work items.',
    systemPrompt:
      'You are a product manager. Your task is to analyze requirements, plan features, and manage the product roadmap. ' +
      'Workflow: (1) clarify goals, target users, and success criteria (use AskUser when requirements are ambiguous), ' +
      '(2) break features into prioritized, testable user stories with acceptance criteria, ' +
      '(3) produce requirement documents and roadmap plans, (4) track work items via task tools. ' +
      'DO NOT modify source code — only write requirement/planning documents. ' +
      'Use the Agent tool to delegate well-specified work items to development agents and review their outcomes ' +
      'against the acceptance criteria.',
    allowedTools: PRODUCT_MANAGER_TOOLS,
    toolRestrictions: [
      { toolName: 'Bash', restrictions: { readOnly: true } },
    ],
    defaultMaxTurns: 30,
    defaultTimeoutSeconds: 600,
  },
};

/**
 * Get a pre-defined agent configuration
 *
 * @param type - Agent type (researcher, implementer, verifier, explorer, general,
 *               frontend, backend, fullstack, code-reviewer, tester, architect, product-manager)
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
    deniedTools: overrides?.deniedTools || def.deniedTools,
    maxTurns: overrides?.maxTurns || def.defaultMaxTurns,
    timeoutSeconds: overrides?.timeoutSeconds || def.defaultTimeoutSeconds,
    tokenBudget: overrides?.tokenBudget,
    model: overrides?.model,
    permissions: overrides?.permissions,
    cwd: overrides?.cwd,
  };
}
