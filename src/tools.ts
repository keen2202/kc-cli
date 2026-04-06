// Tool registry and assembly

import type { ToolDefinition, ToolName, ToolRegistry } from '../types/tools';

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

// Batch 5: Multi-agent coordination (TODO: fix Windows ESM path issue)
// import { tool as TeamCreateTool } from './orchestrator/team-create-tool.js';

class ToolRegistryImpl implements ToolRegistry {
  tools: Map<ToolName, ToolDefinition> = new Map();

  getTool(name: ToolName): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter(tool => tool.isEnabled?.() !== false)
      .sort((a, b) => a.name.localeCompare(b.name)); // Stable sort for prompt cache
  }

  registerTool(tool: ToolDefinition): void {
    this.tools.set(tool.name as ToolName, tool);
  }

  unregisterTool(name: ToolName): void {
    this.tools.delete(name);
  }

  /**
   * Filter tools by deny rules
   */
  filterByDenyRules(denyPatterns: string[]): ToolDefinition[] {
    return this.getAllTools().filter(tool => {
      return !denyPatterns.some(pattern => {
        return pattern === tool.name || pattern.startsWith(`${tool.name}(`);
      });
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
    // Batch 5: Multi-agent coordination (TODO: fix Windows ESM path issue)
    // TeamCreateTool,
  ];
  
  for (const tool of implementedTools) {
    try {
      toolRegistry.registerTool(tool);
    } catch (error) {
      console.warn(`Warning: Failed to register tool ${tool.name}:`, error);
    }
  }
}
