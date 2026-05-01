import type { Plugin, PluginHooks, PluginStatus } from './types';
import type { ToolDefinition } from '../types/tools';
import { discoverPlugins, loadPlugin } from './plugin-loader';
import { registerPostTurnHook } from '../hooks/postTurnHooks';

interface LoadedPlugin {
  plugin: Plugin;
  status: PluginStatus;
  error?: string;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>();

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
      }
    }
  }

  async shutdownAll(): Promise<void> {
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
              await existing(toolName, input, result, context);
              await pluginHook(toolName, input, result, context);
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
    }
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
