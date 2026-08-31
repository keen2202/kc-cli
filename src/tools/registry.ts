import type { ToolDefinition } from '../tools/protocol';
import { logger } from '../services/logger';

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
export const TOOL_MANIFEST = [
  // CRITICAL — always eagerly loaded
  { name: 'Bash', modulePath: './BashTool/index.js', priority: ToolPriority.CRITICAL, eager: true },
  { name: 'FileRead', modulePath: './FileReadTool/index.js', priority: ToolPriority.CRITICAL, eager: true },
  // HIGH — core tools
  { name: 'FileWrite', modulePath: './FileWriteTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'WebSearch', modulePath: './WebSearchTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'FileEdit', modulePath: './FileEditTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'FileRestore', modulePath: './FileRestoreTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'Grep', modulePath: './GrepTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'Glob', modulePath: './GlobTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'WebFetch', modulePath: './WebFetchTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'Git', modulePath: './GitTool/index.js', priority: ToolPriority.HIGH, eager: true },
  { name: 'Run', modulePath: './RunTool/index.js', priority: ToolPriority.HIGH, eager: true },
  // MEDIUM — system tools
  { name: 'Sql', modulePath: './SqlTool/index.js', priority: ToolPriority.MEDIUM, eager: true },
  { name: 'Docker', modulePath: './DockerTool/index.js', priority: ToolPriority.MEDIUM, eager: true },
  { name: 'Monitor', modulePath: './MonitorTool/index.js', priority: ToolPriority.MEDIUM, eager: true },
  { name: 'Config', modulePath: './ConfigTool/index.js', priority: ToolPriority.MEDIUM, eager: true },
  // LOW — task management
  { name: 'TodoWrite', modulePath: './TodoWriteTool/index.js', priority: ToolPriority.LOW, eager: true },
  { name: 'TaskCreate', modulePath: './TaskCreateTool/index.js', priority: ToolPriority.LOW, eager: true },
  { name: 'TaskGet', modulePath: './TaskGetTool/index.js', priority: ToolPriority.LOW, eager: true },
  { name: 'AskUser', modulePath: './AskUserTool/index.js', priority: ToolPriority.LOW, eager: true },
  // DEFERRED — advanced tools; entries are lightweight, heavy code lives in impl modules
  { name: 'Agent', modulePath: './AgentTool/index.js', priority: ToolPriority.DEFERRED, eager: true },
  { name: 'Deploy', modulePath: './DeployTool/index.js', priority: ToolPriority.DEFERRED, eager: true },
  { name: 'TeamCreate', modulePath: '../orchestrator/team-create-tool.js', priority: ToolPriority.DEFERRED, eager: true },
  { name: 'LSP', modulePath: '../lsp/tool.js', priority: ToolPriority.DEFERRED, eager: true },
] as const;

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
      logger.tools.warn(`Tool module has no tool/default/register export: ${entry.name}`, {
        modulePath: entry.modulePath,
      });
      return undefined;
    }

    return toolDef;
  } catch (error) {
    logger.tools.warn(`Failed to load tool module: ${entry.name}`, {
      modulePath: entry.modulePath,
      error: String(error),
    });
    return undefined;
  }
}
