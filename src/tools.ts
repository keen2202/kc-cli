// Tool registry and assembly

import type { ToolDefinition, ToolName, ToolRegistry } from './tools/protocol';
import { logger } from './services/logger';
import {
  TOOL_MANIFEST,
  ToolPriority,
  loadToolModule,
  type ToolManifestEntry,
} from './tools/registry';

// Import eagerly-loaded tools statically (CRITICAL + HIGH priority)
// These are always needed and benefit from static analysis / tree-shaking.

// Core tools (CRITICAL)
import { tool as BashTool } from './tools/BashTool/index.js';
import { tool as FileReadTool } from './tools/FileReadTool/index.js';
// HIGH priority
import { tool as FileWriteTool } from './tools/FileWriteTool/index.js';
import { tool as WebSearchTool } from './tools/WebSearchTool/index.js';
import { tool as FileEditTool } from './tools/FileEditTool/index.js';
import { tool as FileRestoreTool } from './tools/FileRestoreTool/index.js';
import { tool as GrepTool } from './tools/GrepTool/index.js';
import { tool as GlobTool } from './tools/GlobTool/index.js';
import { tool as WebFetchTool } from './tools/WebFetchTool/index.js';
import { tool as GitTool } from './tools/GitTool/index.js';
import { tool as RunTool } from './tools/RunTool/index.js';
// MEDIUM / LOW / DEFERRED — entries are lightweight after the lazy split;
// heavy runtimes (better-sqlite3, orchestrator, LSP clients) live in impl
// modules loaded on first call.
import { tool as SqlTool } from './tools/SqlTool/index.js';
import { tool as DockerTool } from './tools/DockerTool/index.js';
import { tool as MonitorTool } from './tools/MonitorTool/index.js';
import { tool as ConfigTool } from './tools/ConfigTool/index.js';
import { tool as TodoWriteTool } from './tools/TodoWriteTool/index.js';
import { tool as TaskCreateTool } from './tools/TaskCreateTool/index.js';
import { tool as TaskGetTool } from './tools/TaskGetTool/index.js';
import { tool as AskUserTool } from './tools/AskUserTool/index.js';
import { tool as AgentTool } from './tools/AgentTool/index.js';
import { tool as DeployTool } from './tools/DeployTool/index.js';
import { tool as TeamCreateTool } from './orchestrator/team-create-tool.js';
import { tool as LSPTool } from './lsp/tool.js';

class ToolRegistryImpl implements ToolRegistry {
  tools: Map<ToolName, ToolDefinition> = new Map();
  mcpTools: Map<string, ToolDefinition> = new Map();
  pluginTools: Map<string, ToolDefinition> = new Map();

  /** Manifest entries for tools not yet loaded (lazy loading queue) */
  private lazyManifest: Map<string, ToolManifestEntry> = new Map();

  /** Tracks in-flight lazy loads to avoid duplicate imports */
  private pendingLoads: Map<string, Promise<ToolDefinition | undefined>> = new Map();

  constructor() {
    // Populate lazy manifest from non-eager entries
    for (const entry of TOOL_MANIFEST) {
      if (!entry.eager) {
        this.lazyManifest.set(entry.name, entry);
      }
    }
  }

  getTool(name: ToolName): ToolDefinition | undefined {
    return this.tools.get(name) || this.mcpTools.get(name) || this.pluginTools.get(name);
  }

  /**
   * Ensure a tool is loaded, loading it lazily from the manifest if needed.
   * Call this before getTool() for tools that may not be eagerly registered.
   * Deduplicates concurrent loads for the same tool.
   */
  async ensureTool(name: string): Promise<ToolDefinition | undefined> {
    // Already registered (eager or previously lazy-loaded)
    const existing = this.tools.get(name as ToolName) || this.mcpTools.get(name) || this.pluginTools.get(name);
    if (existing) return existing;

    // Check if it's in the lazy manifest
    const entry = this.lazyManifest.get(name);
    if (!entry) return undefined;

    // Deduplicate in-flight loads
    const pending = this.pendingLoads.get(name);
    if (pending) return pending;

    const loadPromise = loadToolModule(entry);
    this.pendingLoads.set(name, loadPromise);

    try {
      const toolDef = await loadPromise;
      if (toolDef) {
        this.registerTool(toolDef);
        this.lazyManifest.delete(name);
        logger.tools.info(`Lazy-loaded tool: ${name}`);
      } else {
        // loadToolModule already logged the root cause; correlate the failure here
        logger.tools.warn(`Lazy-load returned no tool definition: ${name}`, {
          modulePath: entry.modulePath,
        });
      }
      this.pendingLoads.delete(name);
      return toolDef ?? undefined;
    } catch (err) {
      this.pendingLoads.delete(name);
      logger.tools.warn(`Failed to lazy-load tool ${name}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Pre-load all lazy tools in the background.
   * Call after startup to warm the tool cache.
   */
  async preloadAllTools(): Promise<void> {
    const entries = Array.from(this.lazyManifest.values());
    await Promise.all(entries.map(entry => this.ensureTool(entry.name)));
  }

  /**
   * Get the list of tool names that are available for lazy loading.
   */
  getLazyToolNames(): string[] {
    return Array.from(this.lazyManifest.keys());
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


/**
 * Register all built-in tools.
 * All built-in tools register eagerly; heavy runtimes are split into impl
 * modules loaded on first call.
 */
export async function registerBuiltInTools(): Promise<void> {
  const eagerTools = [
    // CRITICAL
    BashTool, FileReadTool,
    // HIGH
    FileWriteTool, WebSearchTool, FileEditTool, FileRestoreTool, GrepTool, GlobTool,
    WebFetchTool, GitTool, RunTool,
    // MEDIUM
    SqlTool, DockerTool, MonitorTool, ConfigTool,
    // LOW
    TodoWriteTool, TaskCreateTool, TaskGetTool, AskUserTool,
    // DEFERRED
    AgentTool, DeployTool, TeamCreateTool, LSPTool,
  ];

  for (const tool of eagerTools) {
    try {
      toolRegistry.registerTool(tool);
    } catch (error) {
      logger.tools.warn(`Warning: Failed to register tool ${tool.name}: ` + String(error));
    }
  }
}
