import type { ToolDefinition } from '../tools/protocol';

/**
 * Tool module convention interface.
 * Tool directories should export either:
 * - A `tool` export (ToolDefinition)
 * - A `register` function
 * - A default export (ToolDefinition)
 */
export interface ToolModule {
  tool?: ToolDefinition;
  register?: () => ToolDefinition;
  default?: ToolDefinition;
}

/**
 * Priority levels for tool loading order.
 * Lower number = loaded first = higher priority in tool list.
 */
export enum ToolPriority {
  CRITICAL = 0,  // Bash, FileRead — always needed
  HIGH = 10,     // Core editing tools
  MEDIUM = 20,   // System tools
  LOW = 30,      // Task management
  DEFERRED = 40, // Advanced tools, loaded on demand
}

/**
 * Tool manifest entry — describes a tool module for discovery and lazy loading.
 */
export interface ToolManifestEntry {
  /** Tool name (must match the tool's `name` property) */
  name: string;
  /** Dynamic import path for the tool module */
  modulePath: string;
  /** Loading priority */
  priority: ToolPriority;
  /** Whether to eagerly load at startup (false = lazy load on first use) */
  eager?: boolean;
}

/**
 * Tool manifest — registry of all available tool modules.
 * Used for auto-discovery and lazy loading.
 */
export const TOOL_MANIFEST: ToolManifestEntry[] = [
  // CRITICAL — always eagerly loaded
  { name: 'Bash', modulePath: './tools/BashTool/index.js', priority: ToolPriority.CRITICAL, eager: true },
  { name: 'FileRead', modulePath: './tools/FileReadTool/index.js', priority: ToolPriority.CRITICAL, eager: true },
  // HIGH — core tools
  { name: 'FileWrite', modulePath: './tools/FileWriteTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'WebSearch', modulePath: './tools/WebSearchTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'FileEdit', modulePath: './tools/FileEditTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'Grep', modulePath: './tools/GrepTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'Glob', modulePath: './tools/GlobTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'WebFetch', modulePath: './tools/WebFetchTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'Git', modulePath: './tools/GitTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'Run', modulePath: './tools/RunTool/index.js', priority: ToolPriority.HIGH, eager: true },
  // MEDIUM — system tools
  { name: 'Sql', modulePath: './tools/SqlTool/index.js', priority: ToolPriority.MEDIUM, eager: false },
  { name: 'Docker', modulePath: './tools/DockerTool/index.js', priority: ToolPriority.MEDIUM, eager: false },
  { name: 'Monitor', modulePath: './tools/MonitorTool/index.js', priority: ToolPriority.MEDIUM, eager: false },
  { name: 'Config', modulePath: './tools/ConfigTool/index.js', priority: ToolPriority.MEDIUM, eager: false },
  // LOW — task management
  { name: 'TodoWrite', modulePath: './tools/TodoWriteTool/index.js', priority: ToolPriority.LOW, eager: false },
  { name: 'TaskCreate', modulePath: './tools/TaskCreateTool/index.js', priority: ToolPriority.LOW, eager: false },
  { name: 'TaskGet', modulePath: './tools/TaskGetTool/index.js', priority: ToolPriority.LOW, eager: false },
  { name: 'AskUser', modulePath: './tools/AskUserTool/index.js', priority: ToolPriority.LOW, eager: false },
  // DEFERRED — advanced tools, always lazy
  { name: 'Agent', modulePath: './tools/AgentTool/index.js', priority: ToolPriority.DEFERRED, eager: false },
  { name: 'Deploy', modulePath: './tools/DeployTool/index.js', priority: ToolPriority.DEFERRED, eager: false },
  { name: 'TeamCreate', modulePath: './orchestrator/team-create-tool.js', priority: ToolPriority.DEFERRED, eager: false },
  { name: 'LSP', modulePath: './lsp/tool.js', priority: ToolPriority.DEFERRED, eager: false },
];

/**
 * Load a tool module dynamically.
 * Extracts the tool definition from the module using the ToolModule convention.
 */
export async function loadToolModule(entry: ToolManifestEntry): Promise<ToolDefinition | undefined> {
  try {
    const mod = (await import(entry.modulePath)) as ToolModule;

    // Extract tool from module using convention order
    const toolDef = mod.tool ?? mod.default ?? mod.register?.();
    if (!toolDef) {
      return undefined;
    }

    return toolDef;
  } catch {
    return undefined;
  }
}
