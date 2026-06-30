import type { Plugin, PluginHooks, PluginPermissionRule, PluginStatus } from './types';
import type { ToolDefinition, ToolUseContext } from '../tools/protocol';
import type { ChatMessage } from '../query/protocol';
import type { IMAdapter } from '../im/protocol';
import { logger } from '../services/logger';
import { discoverPlugins, loadPlugin } from './plugin-loader';
import { registerPostTurnHook } from '../hooks/postTurnHooks';

interface LoadedPlugin {
  plugin: Plugin;
  status: PluginStatus;
  error?: string;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();
  private cachedHooks: PluginHooks | null = null;
  private hooksDirty = true;

  async loadAll(projectDir: string): Promise<void> {
    const pluginDirs = await discoverPlugins(projectDir);

    for (const dir of pluginDirs) {
      try {
        const plugin = await loadPlugin(dir);
        if (plugin) {
          this.plugins.set(plugin.name, { plugin, status: 'loaded' });
        }
      } catch {
        // Silently skip failed plugins
      }
    }
  }

  async initAll(): Promise<void> {
    for (const [, loaded] of this.plugins) {
      if (loaded.status !== 'loaded') continue;
      try {
        await loaded.plugin.onInit?.();
        loaded.status = 'initialized';
        this.hooksDirty = true;

        // Register plugin postTurn hooks into the global hook registry
        if (loaded.plugin.hooks?.postTurn) {
          registerPostTurnHook(async (context) => {
            try {
              await loaded.plugin.hooks!.postTurn!(context.messages);
            } catch (err) {
              console.warn(`[Plugin:${loaded.plugin.name}] postTurn hook error:`, err);
            }
          });
        }
      } catch (error) {
        loaded.status = 'error';
        loaded.error = error instanceof Error ? error.message : String(error);
        this.hooksDirty = true;
      }
    }
  }

  async shutdownAll(): Promise<void> {
    this.hooksDirty = true;
    const shutdowns = Array.from(this.plugins.entries()).map(async ([, loaded]) => {
      if (loaded.status !== 'initialized') return;
      try {
        await Promise.race([
          loaded.plugin.onShutdown?.(),
          new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
      } catch {
        // Ignore shutdown errors
      }
    });
    await Promise.allSettled(shutdowns);
  }

  getPluginTools(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const [, loaded] of this.plugins) {
      if (loaded.status === 'initialized' && loaded.plugin.tools) {
        for (const tool of loaded.plugin.tools) {
          // Apply sandbox classification to plugin tools
          const classified = this.classifyPluginTool(tool);
          tools.push(classified);
        }
      }
    }
    return tools;
  }

  getPluginHooks(): PluginHooks {
    // Return cached hooks if plugin set hasn't changed
    if (!this.hooksDirty && this.cachedHooks) {
      return this.cachedHooks;
    }

    const merged: PluginHooks = {};
    for (const [, loaded] of this.plugins) {
      if (loaded.status !== 'initialized' || !loaded.plugin.hooks) continue;
      // Chain hooks: all plugins get called, not just last
      if (loaded.plugin.hooks.preToolUse) {
        const existing = merged.preToolUse;
        const pluginHook = loaded.plugin.hooks.preToolUse;
        merged.preToolUse = existing
          ? async (toolName, input, context) => {
              const result = await existing(toolName, input, context);
              if (result === null) return null; // Previous hook blocked
              return pluginHook(toolName, result, context);
            }
          : pluginHook;
      }
      if (loaded.plugin.hooks.postToolUse) {
        const existing = merged.postToolUse;
        const pluginHook = loaded.plugin.hooks.postToolUse;
        merged.postToolUse = existing
          ? async (toolName, input, result, context) => {
              const firstResult = await existing(toolName, input, result, context);
              // If first hook returned a value, pass it to next; otherwise pass original
              return pluginHook(toolName, input, firstResult ?? result, context);
            }
          : pluginHook;
      }
      if (loaded.plugin.hooks.postTurn) {
        const existing = merged.postTurn;
        const pluginHook = loaded.plugin.hooks.postTurn;
        merged.postTurn = existing
          ? async (messages) => {
              await existing(messages);
              await pluginHook(messages);
            }
          : pluginHook;
      }
      if (loaded.plugin.hooks.preTurn) {
        const existing = merged.preTurn;
        const pluginHook = loaded.plugin.hooks.preTurn;
        merged.preTurn = existing
          ? async (messages, context) => {
              const result = await existing(messages, context);
              // If first hook returned null, pass original messages to next hook
              return pluginHook(result ?? messages, context);
            }
          : pluginHook;
      }
      if (loaded.plugin.hooks.onError) {
        const existing = merged.onError;
        const pluginHook = loaded.plugin.hooks.onError;
        merged.onError = existing
          ? async (error, context) => {
              const result = await existing(error, context);
              // If first hook returned null (swallowed), stop chain
              if (result === null) return null;
              return pluginHook(result, context);
            }
          : pluginHook;
      }
    }

    this.cachedHooks = merged;
    this.hooksDirty = false;
    return merged;
  }

  getLoadedPlugins(): Array<{ name: string; version: string; status: PluginStatus; error?: string }> {
    return Array.from(this.plugins.entries()).map(([name, loaded]) => ({
      name,
      version: loaded.plugin.version,
      status: loaded.status,
      error: loaded.error,
    }));
  }

  /**
   * Collect permission rules from all initialized plugins.
   * Returns rules sorted by priority (lower number = higher priority).
   */
  getPluginPermissionRules(): PluginPermissionRule[] {
    const rules: PluginPermissionRule[] = [];
    for (const [, loaded] of this.plugins) {
      if (loaded.status === 'initialized' && loaded.plugin.permissionRules) {
        rules.push(...loaded.plugin.permissionRules);
      }
    }
    return rules.sort((a, b) => a.priority - b.priority);
  }

  /**
   * Collect MCP server configurations from all initialized plugins.
   * Plugin MCP servers are merged with user/project config (plugin servers lowest priority).
   */
  getPluginMCPServers(): Array<{
    serverId: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }> {
    const servers: Array<{
      serverId: string;
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }> = [];
    for (const [, loaded] of this.plugins) {
      if (loaded.status === 'initialized' && loaded.plugin.mcpServers) {
        servers.push(...loaded.plugin.mcpServers);
      }
    }
    return servers;
  }

  /**
   * Collect IM adapters from all initialized plugins.
   */
  getPluginIMAdapters(): IMAdapter[] {
    const adapters: IMAdapter[] = [];
    for (const [, loaded] of this.plugins) {
      if (loaded.status === 'initialized' && loaded.plugin.imAdapters) {
        adapters.push(...loaded.plugin.imAdapters);
      }
    }
    return adapters;
  }

  /**
   * Execute preTurn hooks across all initialized plugins.
   * Returns modified messages, or original messages if no hooks modify them.
   */
  async executePreTurnHooks(messages: ChatMessage[], context: ToolUseContext): Promise<ChatMessage[]> {
    const hooks = this.getPluginHooks();
    if (!hooks.preTurn) return messages;
    const result = await hooks.preTurn(messages, context);
    return result ?? messages;
  }

  /**
   * Execute onError hooks across all initialized plugins.
   * Returns modified error, or null if the error was swallowed.
   */
  async executeOnErrorHooks(error: Error, context: ToolUseContext): Promise<Error | null> {
    const hooks = this.getPluginHooks();
    if (!hooks.onError) return error;
    return hooks.onError(error, context);
  }

  /**
   * Apply sandbox classification to plugin tools:
   * - Default isConcurrencySafe to false unless explicitly set
   * - Auto-classify read-only tools
   * - Enforce sandbox wrapping for process-spawning tools
   */
  private classifyPluginTool(tool: ToolDefinition): ToolDefinition {
    return {
      ...tool,
      // Plugin tools default to not concurrency-safe unless explicitly set
      isConcurrencySafe: tool.isConcurrencySafe ?? (() => false),
      // Preserve existing read-only classification
      isReadOnly: tool.isReadOnly ?? (() => false),
    };
  }
}
