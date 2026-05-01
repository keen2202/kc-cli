import type { ToolDefinition, ToolUseContext } from '../types/tools';

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  tools?: ToolDefinition[];
  hooks?: PluginHooks;
  onInit?(): Promise<void>;
  onShutdown?(): Promise<void>;
}

export interface PluginHooks {
  preToolUse?: (toolName: string, input: Record<string, unknown>, context: ToolUseContext) => Promise<Record<string, unknown> | null>;
  postToolUse?: (toolName: string, input: Record<string, unknown>, result: unknown, context: ToolUseContext) => Promise<void>;
  postTurn?: (messages: unknown[]) => Promise<void>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  main: string;
  kcPlugin?: boolean;
}

export type PluginStatus = 'loaded' | 'initialized' | 'error' | 'disabled';
