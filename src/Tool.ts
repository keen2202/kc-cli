// Tool base type and factory

import { z } from 'zod';
import type {
  ToolDefinition,
  ToolUseContext,
  ToolResult,
  ToolCallProgress,
} from './tools/protocol';
import { withToolErrorHandling } from './utils/errorHandling';

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
export function toolError(message: string, metadata?: Record<string, unknown>): ToolResult<never> {
  return {
    output: null as never,
    isError: true,
    message,
    metadata,
  };
}
