// Tool types and interfaces

import { z } from 'zod';
import type { PermissionResult, PermissionContext } from '../types/permissions';
import type { ExecutionEnv } from '../services/execution-env';

// Forward reference to avoid circular import
export interface SandboxManagerLike {
  isAvailable(): boolean;
  wrapCommand(command: string, toolName?: string): string;
  getBackendName(): string;
  shouldSandboxTool(toolName: string): 'run-sandboxed' | 'run-unsandboxed' | 'deny';
}

export interface ToolUseContext {
  cwd: string;
  abortController: AbortController;
  permissions: PermissionContext;
  /** Sandbox manager for command isolation. May be undefined if sandboxing is disabled. */
  sandbox?: SandboxManagerLike;
  /** Execution environment abstraction for filesystem and shell access. Optional for backward compatibility. */
  env?: ExecutionEnv;
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
  timedOut?: boolean; // True if the tool execution timed out
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

  /**
   * Optional pre-execution hook called before the tool's `call()`.
   * Can modify input, skip execution entirely, or provide an early result.
   */
  prepare?: (
    input: Input,
    context: ToolUseContext
  ) => Promise<{ input: Input; skip?: boolean; result?: ToolResult<Output> }>;

  /**
   * Optional post-execution hook called after the tool's `call()`.
   * Can transform or augment the result before it is returned.
   * Note: result parameter uses ToolResult<unknown> for type variance compatibility.
   */
  finalize?: (
    input: Input,
    result: ToolResult<unknown>,
    context: ToolUseContext
  ) => Promise<ToolResult<Output>>;

  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
  timeout?: number; // Custom timeout in ms for this tool
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
