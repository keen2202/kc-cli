// Unified error handling utilities

import { isExecError, getErrorMessage, getErrorStack } from '../types/errors';
import { logger } from '../services/logger';

/**
 * Options for withToolErrorHandling wrapper.
 */
export interface ToolErrorHandlingOptions<T> {
  /** Fallback value to return on error */
  fallback?: T;
  /** Whether to rethrow the error after handling */
  rethrow?: boolean;
  /** Custom error message prefix */
  messagePrefix?: string;
  /** Whether to log the error */
  logError?: boolean;
}

/**
 * Unified error handling wrapper for tool operations.
 * Provides consistent error handling across all tools.
 *
 * @param toolName Name of the tool for logging
 * @param operation The async operation to execute
 * @param options Error handling options
 * @returns Result of the operation or fallback value
 */
export async function withToolErrorHandling<T>(
  toolName: string,
  operation: () => Promise<T>,
  options: ToolErrorHandlingOptions<T> = {}
): Promise<T> {
  const {
    fallback,
    rethrow = false,
    messagePrefix = 'Tool execution failed',
    logError = true,
  } = options;

  try {
    return await operation();
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    const errorStack = getErrorStack(error);

    if (logError) {
      const logMessage = `[${toolName}] ${messagePrefix}: ${errorMessage}`;
      logger.tools.error(logMessage, errorStack ? { stack: errorStack } : undefined);
    }

    if (rethrow) {
      throw error;
    }

    if (fallback !== undefined) {
      return fallback;
    }

    // Re-throw if no fallback provided
    throw error;
  }
}

/**
 * Format error for tool result output.
 * Provides consistent error formatting across tools.
 */
export function formatToolError(
  toolName: string,
  error: unknown,
  context?: Record<string, unknown>
): {
  output: string;
  isError: true;
  metadata: Record<string, unknown>;
} {
  const errorMessage = getErrorMessage(error);
  const errorStack = getErrorStack(error);

  // Build metadata
  const metadata: Record<string, unknown> = {
    tool: toolName,
    errorType: error instanceof Error ? error.constructor.name : typeof error,
  };

  // Add exec error specific metadata
  if (isExecError(error)) {
    if (error.code !== undefined) metadata.exitCode = error.code;
    if (error.signal !== undefined) metadata.signal = error.signal;
    if (error.stderr !== undefined) metadata.stderr = error.stderr;
  }

  // Add additional context
  if (context) {
    Object.assign(metadata, context);
  }

  // Build output message
  let output = `${toolName} failed: ${errorMessage}`;

  // Add stderr if available and different from message
  if (isExecError(error) && error.stderr && error.stderr !== errorMessage) {
    output += `\n\nStderr:\n${error.stderr}`;
  }

  return {
    output,
    isError: true,
    metadata,
  };
}

/**
 * Wrap a synchronous operation with error handling.
 */
export function withSyncErrorHandling<T>(
  toolName: string,
  operation: () => T,
  fallback: T
): T {
  try {
    return operation();
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    logger.tools.error(`[${toolName}] Sync operation failed: ${errorMessage}`);
    return fallback;
  }
}

/**
 * Create a standardized error result for tools.
 */
export function createErrorResult(
  toolCallId: string,
  message: string,
  metadata?: Record<string, unknown>
): {
  toolCallId: string;
  output: string;
  isError: true;
  metadata?: Record<string, unknown>;
} {
  return {
    toolCallId,
    output: message,
    isError: true,
    metadata,
  };
}

/**
 * Check if an error is a timeout error.
 */
export function isTimeoutError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('timeout') ||
      error.message.includes('timed out') ||
      error.name === 'TimeoutError'
    );
  }
  return false;
}

/**
 * Check if an error is a network error.
 */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('econnrefused') ||
      message.includes('econnreset') ||
      message.includes('enotfound') ||
      message.includes('fetch failed')
    );
  }
  return false;
}

/**
 * Check if an error is a permission error.
 */
export function isPermissionError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('permission') ||
      message.includes('access denied') ||
      message.includes('eacces') ||
      message.includes('eperm')
    );
  }
  return false;
}

/**
 * Extract error code from error object.
 * Returns the error code or a default based on error type.
 */
export function getErrorCode(error: unknown): string {
  if (isTimeoutError(error)) return 'TIMEOUT';
  if (isNetworkError(error)) return 'NETWORK';
  if (isPermissionError(error)) return 'PERMISSION';
  if (isExecError(error)) return 'EXEC';
  return 'UNKNOWN';
}
