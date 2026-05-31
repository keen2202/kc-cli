import type { ToolDefinition, ToolUseContext } from '../types/tools';
import type { ChatMessage } from '../types/message';

export interface PluginHooks {
  preToolUse?: (toolName: string, input: Record<string, unknown>, context: ToolUseContext) => Promise<Record<string, unknown> | null>;
  postToolUse?: (toolName: string, input: Record<string, unknown>, result: unknown, context: ToolUseContext) => Promise<unknown | null>;
  postTurn?: (messages: unknown[]) => Promise<void>;
  preTurn?: (messages: ChatMessage[], context: ToolUseContext) => Promise<ChatMessage[] | null>;
  onError?: (error: Error, context: ToolUseContext) => Promise<Error | null>;
}

export interface PluginPermissionRule {
  toolPattern: string;      // e.g., "Bash", "FileWrite", "*"
  contentPattern?: string;  // e.g., "rm -rf *", "*.env"
  behavior: 'allow' | 'deny' | 'ask';
  priority: number;
}

export interface PluginPrompt {
  name: string;
  template: string;
  description: string;
  args?: Record<string, { type: string; description: string; required?: boolean }>;
}

export interface PluginMCPConfig {
  serverId: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface Plugin {
  name: string;
  version: string;
  description?: string;
  tools?: ToolDefinition[];
  hooks?: PluginHooks;
  permissionRules?: PluginPermissionRule[];
  prompts?: PluginPrompt[];
  mcpServers?: PluginMCPConfig[];
  onInit?(): Promise<void>;
  onShutdown?(): Promise<void>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  main: string;
  kcPlugin?: boolean;
}

export type PluginStatus = 'loaded' | 'initialized' | 'error' | 'disabled';
