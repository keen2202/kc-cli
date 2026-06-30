// Tool types and interfaces

import { z } from 'zod';
import type { PermissionResult, PermissionContext } from '../permissions/protocol';
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

  shouldDefer?: boolean;
  alwaysLoad?: boolean;
  searchHint?: string;
  timeout?: number; // Custom timeout in ms for this tool

  // ── AGP Extension Fields (optional, backward-compatible) ──────────────────

  /** AGP evolvability marker: 1 = evolvable by SEPL operators, 0 = frozen */
  agpEvolvability?: 0 | 1;
  /** AGP version string (semver) */
  agpVersion?: string;
  /** AGP implementation descriptor (import path or source) */
  agpImplementationDescriptor?: string;
}

import type { TOOL_MANIFEST } from './registry';

export type ToolName = typeof TOOL_MANIFEST[number]['name'];

export interface ToolRegistry {
  tools: Map<ToolName, ToolDefinition>;
  getTool(name: ToolName): ToolDefinition | undefined;
  getAllTools(): ToolDefinition[];
  registerTool(tool: ToolDefinition): void;
  unregisterTool(name: ToolName): void;
}
