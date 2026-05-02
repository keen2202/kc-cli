// Tool types and interfaces

import { z } from 'zod';
import type { PermissionResult, PermissionContext } from './permissions';

export interface ToolUseContext {
  cwd: string;
  abortController: AbortController;
  permissions: PermissionContext;
  onProgress?: (progress: ToolCallProgress) => void;
  appendSystemMessage?: (message: string) => void;
}

export interface ToolCallProgress {
  toolName: string;
  status: string;
  percentage?: number;
  message?: string;
}

export interface ToolResult<T = unknown> {
  toolCallId?: string; // Optional: links result to specific tool call
  output: T;
  isError: boolean;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDefinition<Input = Record<string, unknown>, Output = unknown, Progress = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<Input, any, any>;
  outputSchema?: z.ZodType<Output>;

  call: (
    input: Input,
    context: ToolUseContext,
    onProgress?: (progress: Progress) => void
  ) => Promise<ToolResult<Output>>;

  checkPermissions?: (
    input: Input,
    context: ToolUseContext
  ) => PermissionResult;

  isReadOnly?: (input: Input) => boolean;
  isConcurrencySafe?: (input: Input) => boolean;
  isDestructive?: (input: Input) => boolean;
  isEnabled?: () => boolean;

  prompt?: (options: { input: Input }) => string;
  getToolUseSummary?: (input: Input) => string | null;
  getActivityDescription?: (input: Input) => string | null;

  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
}

export type ToolName =
  | 'Bash'
  | 'FileRead'
  | 'FileWrite'
  | 'FileEdit'
  | 'Glob'
  | 'Grep'
  | 'WebFetch'
  | 'WebSearch'
  | 'Sql'
  | 'Docker'
  | 'Deploy'
  | 'Monitor'
  | 'Run'
  | 'Git'
  | 'TodoWrite'
  | 'Agent'
  | 'AskUser'
  | 'TaskCreate'
  | 'TaskGet'
  | 'Config'
  | 'TeamCreate';

export interface ToolRegistry {
  tools: Map<ToolName, ToolDefinition>;
  getTool(name: ToolName): ToolDefinition | undefined;
  getAllTools(): ToolDefinition[];
  registerTool(tool: ToolDefinition): void;
  unregisterTool(name: ToolName): void;
}
