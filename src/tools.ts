// Tool registry and assembly

import type { ToolDefinition, ToolName, ToolRegistry } from './types/tools';
import { logger } from './services/logger';

// Import implemented tools statically to avoid Windows path issues with dynamic imports
// Note: Using .js extension for ESM compatibility with tsx

// Core tools
import { tool as BashTool } from './tools/BashTool/index.js';
import { tool as FileReadTool } from './tools/FileReadTool/index.js';
import { tool as FileWriteTool } from './tools/FileWriteTool/index.js';
import { tool as WebSearchTool } from './tools/WebSearchTool/index.js';

// Batch 1: Core editing and search tools
import { tool as FileEditTool } from './tools/FileEditTool/index.js';
import { tool as GrepTool } from './tools/GrepTool/index.js';
import { tool as GlobTool } from './tools/GlobTool/index.js';
import { tool as WebFetchTool } from './tools/WebFetchTool/index.js';
import { tool as GitTool } from './tools/GitTool/index.js';
import { tool as RunTool } from './tools/RunTool/index.js';

// Batch 2: System tools
import { tool as SqlTool } from './tools/SqlTool/index.js';
import { tool as DockerTool } from './tools/DockerTool/index.js';
import { tool as MonitorTool } from './tools/MonitorTool/index.js';
import { tool as ConfigTool } from './tools/ConfigTool/index.js';

// Batch 3: Task management tools
import { tool as TodoWriteTool } from './tools/TodoWriteTool/index.js';
import { tool as TaskCreateTool } from './tools/TaskCreateTool/index.js';
import { tool as TaskGetTool } from './tools/TaskGetTool/index.js';
import { tool as AskUserTool } from './tools/AskUserTool/index.js';

// Batch 4: Advanced tools
import { tool as AgentTool } from './tools/AgentTool/index.js';
import { tool as DeployTool } from './tools/DeployTool/index.js';

// Batch 5: Multi-agent coordination
import { tool as TeamCreateTool } from './orchestrator/team-create-tool.js';

// Batch 6: LSP integration
import { tool as LSPTool } from './lsp/tool.js';

class ToolRegistryImpl implements ToolRegistry {
  tools: Map<ToolName, ToolDefinition> = new Map();
  mcpTools: Map<string, ToolDefinition> = new Map();
  pluginTools: Map<string, ToolDefinition> = new Map();

  getTool(name: ToolName): ToolDefinition | undefined {
    return this.tools.get(name) || this.mcpTools.get(name) || this.pluginTools.get(name);
  }

  getAllTools(): ToolDefinition[] {
    const allTools = [...this.tools.values(), ...this.mcpTools.values(), ...this.pluginTools.values()];
    return allTools
      .filter(tool => tool.isEnabled?.() !== false)
      .sort((a, b) => a.name.localeCompare(b.name)); // Stable sort for prompt cache
  }

  registerTool(tool: ToolDefinition<any, any, any>): void {
    this.tools.set(tool.name as ToolName, tool);
  }

  registerMCPTool(tool: ToolDefinition): void {
    this.mcpTools.set(tool.name, tool);
  }

  registerPluginTool(tool: ToolDefinition): void {
    this.pluginTools.set(tool.name, tool);
  }

  unregisterMCPTools(): void {
    this.mcpTools.clear();
  }

  unregisterPluginTools(): void {
    this.pluginTools.clear();
  }

  unregisterTool(name: ToolName): void {
    this.tools.delete(name);
    this.mcpTools.delete(name);
    this.pluginTools.delete(name);
  }

  /**
   * Filter tools by deny rules
   * Pre-processes patterns into a Set for O(1) exact match lookups
   */
  filterByDenyRules(denyPatterns: string[]): ToolDefinition[] {
    // Separate exact matches from pattern matches for faster lookup
    const exactDenySet = new Set<string>();
    const prefixPatterns: string[] = [];

    for (const pattern of denyPatterns) {
      const parenIdx = pattern.indexOf('(');
      if (parenIdx === -1) {
        exactDenySet.add(pattern);
      } else {
        prefixPatterns.push(pattern);
      }
    }

    return this.getAllTools().filter(tool => {
      // O(1) Set lookup for exact matches
      if (exactDenySet.has(tool.name)) return false;
      // Check prefix patterns only if no exact match
      return !prefixPatterns.some(pattern => pattern.startsWith(`${tool.name}(`));
    });
  }

  /**
   * Assemble tool pool (built-in + MCP + plugins)
   */
  assembleToolPool(options: {
    denyRules?: string[];
    additionalTools?: ToolDefinition[];
  } = {}): ToolDefinition[] {
    let tools = this.getAllTools();

    // Filter by deny rules
    if (options.denyRules && options.denyRules.length > 0) {
      tools = this.filterByDenyRules(options.denyRules);
    }

    // Add additional tools
    if (options.additionalTools) {
      for (const tool of options.additionalTools) {
        if (!this.tools.has(tool.name as ToolName)) {
          tools.push(tool);
        }
      }
    }

    return tools;
  }
}

// Singleton registry
export const toolRegistry = new ToolRegistryImpl();

// Register with DI container for consumers
import { getServiceContainer } from './services/ServiceContainer';
getServiceContainer().register('toolRegistry', () => toolRegistry, 'singleton');

/**
 * Register all built-in tools
 */
export async function registerBuiltInTools(): Promise<void> {
  // Register all implemented tools
  const implementedTools = [
    // Original core tools
    BashTool, FileReadTool, FileWriteTool, WebSearchTool,
    // Batch 1: Core editing and search
    FileEditTool, GrepTool, GlobTool, WebFetchTool, GitTool, RunTool,
    // Batch 2: System tools
    SqlTool, DockerTool, MonitorTool, ConfigTool,
    // Batch 3: Task management
    TodoWriteTool, TaskCreateTool, TaskGetTool, AskUserTool,
    // Batch 4: Advanced tools
    AgentTool, DeployTool,
    // Batch 5: Multi-agent coordination
    TeamCreateTool,
    // Batch 6: LSP integration
    LSPTool,
  ];
  
  for (const tool of implementedTools) {
    try {
      toolRegistry.registerTool(tool);
    } catch (error) {
      logger.tools.warn(`Warning: Failed to register tool ${tool.name}: ` + String(error));
    }
  }
}
