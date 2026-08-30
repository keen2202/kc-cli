// Tool base type and factory

import { z } from 'zod';
import type {
  ToolDefinition,
  ToolUseContext,
  ToolResult,
  ToolCallProgress,
} from './tools/protocol';
import type { PermissionResult } from './permissions/protocol';
import { withToolErrorHandling } from './utils/errorHandling';
import { getErrorMessage } from './utils/errors';

/**
 * Build a tool with sensible defaults.
 * Automatically wraps call() with unified error handling for consistent
 * error formatting and logging across all tools.
 */
export function buildTool<Input, Output, Progress = unknown>(
  definition: ToolDefinition<Input, Output, Progress>
): ToolDefinition<Input, Output, Progress> {
  const originalCall = definition.call;

  const wrappedCall = originalCall
    ? (input: Input, context: ToolUseContext, onProgress?: (progress: Progress) => void) =>
        withToolErrorHandling(
          definition.name,
          () => originalCall(input, context, onProgress),
          { messagePrefix: `${definition.name} execution failed` }
        )
    : undefined;

  return {
    ...definition,
    ...(wrappedCall ? { call: wrappedCall } : {}),
    isReadOnly: definition.isReadOnly ?? (() => false),
    isConcurrencySafe: definition.isConcurrencySafe ?? (() => true),
    isDestructive: definition.isDestructive ?? (() => false),
    isEnabled: definition.isEnabled ?? (() => true),
    checkPermissions: definition.checkPermissions ?? (() => ({
      behavior: 'passthrough' as const,
      message: 'No permission check defined',
    })),
  };
}

/**
 * Create a simple tool result
 */
export function toolResult<T>(
  output: T,
  options: { isError?: boolean; message?: string; metadata?: Record<string, unknown> } = {}
): ToolResult<T> {
  return {
    output,
    isError: options.isError ?? false,
    message: options.message,
    metadata: options.metadata,
  };
}

/**
 * Create an error tool result
 */
/**
 * M8: shared readonly allow decision. Every read-only tool previously carried
 * its own copy of this boilerplate, and one of the six used
 * `updatedInput: undefined` where the rest used `{}` — now one shape.
 */
export function readonlyAllow(reason: string): PermissionResult {
  return {
    behavior: 'allow',
    updatedInput: {},
    decisionReason: { type: 'readonly', reason },
  };
}

/**
 * M5: uniform tool failure result. Routes the error text through
 * `getErrorMessage` so error-like plain objects (deserialized / cross-process
 * errors with a `message` field) render their message instead of `[object Object]`.
 */
export function toolFailure(
  toolName: string,
  error: unknown,
  metadata?: Record<string, unknown>,
): ToolResult<never> {
  return toolError(`${toolName} failed: ${getErrorMessage(error)}`, metadata);
}

export function toolError(message: string, metadata?: Record<string, unknown>): ToolResult<never> {
  return {
    output: null as never,
    isError: true,
    message,
    metadata,
  };
}
