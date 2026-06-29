/**
 * Error interface for command execution errors.
 * Extends the standard Error with properties from child_process errors.
 */
export interface ExecError extends Error {
  /** Exit code from the process */
  code?: number;
  /** Signal that killed the process */
  signal?: string;
  /** Standard error output */
  stderr?: string;
  /** Standard output */
  stdout?: string;
  /** The command that was executed */
  cmd?: string;
  /** Whether the process was killed by timeout */
  killed?: boolean;
}

/**
 * Type guard to check if an error is an ExecError.
 */
export function isExecError(error: unknown): error is ExecError {
  return (
    error instanceof Error &&
    (
      'code' in error ||
      'signal' in error ||
      'stderr' in error ||
      'stdout' in error
    )
  );
}

/**
 * Safely extract error message from unknown error type.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  return String(error);
}

/**
 * Safely extract error stack from unknown error type.
 */
export function getErrorStack(error: unknown): string | undefined {
  if (error instanceof Error) {
    return error.stack;
  }
  return undefined;
}

/**
 * All possible error codes for KCError.
 */
export type ErrorCode =
  | 'api_rate_limit'
  | 'api_auth_failed'
  | 'api_bad_request'
  | 'api_server_error'
  | 'api_timeout'
  | 'tool_not_found'
  | 'tool_timeout'
  | 'tool_permission_denied'
  | 'tool_execution_failed'
  | 'compaction_failed'
  | 'compaction_timeout'
  | 'state_invalid_transition'
  | 'state_machine_error'
  | 'sandbox_unavailable'
  | 'sandbox_denied'
  | 'session_not_found'
  | 'budget_exceeded'
  | 'model_no_patch'
  | 'unknown';

/**
 * Unified error type for KC-CLI.
 * Provides structured error information with error codes and optional context.
 */
export class KCError extends Error {
  readonly code: ErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, context?: Record<string, unknown>, cause?: Error) {
    super(message, { cause });
    this.name = 'KCError';
    this.code = code;
    this.context = context;
  }

  /**
   * Create a KCError from an ApiError, classifying the error code based on status code and message.
   */
  static fromApiError(apiError: Error & { statusCode?: number }): KCError {
    const statusCode = apiError.statusCode;
    const message = apiError.message.toLowerCase();

    // Classify by status code first
    if (statusCode !== undefined) {
      if (statusCode === 429) {
        return new KCError('api_rate_limit', apiError.message, { statusCode }, apiError);
      }
      if (statusCode === 401 || statusCode === 403) {
        return new KCError('api_auth_failed', apiError.message, { statusCode }, apiError);
      }
      if (statusCode === 400 || statusCode === 404 || statusCode === 422) {
        return new KCError('api_bad_request', apiError.message, { statusCode }, apiError);
      }
      if (statusCode >= 500) {
        return new KCError('api_server_error', apiError.message, { statusCode }, apiError);
      }
    }

    // Fall back to message-based classification
    if (message.includes('429') || message.includes('rate limit')) {
      return new KCError('api_rate_limit', apiError.message, undefined, apiError);
    }
    if (message.includes('timeout')) {
      return new KCError('api_timeout', apiError.message, undefined, apiError);
    }
    if (message.includes('unauthorized') || message.includes('auth')) {
      return new KCError('api_auth_failed', apiError.message, undefined, apiError);
    }
    if (message.includes('server error') || message.includes('500')) {
      return new KCError('api_server_error', apiError.message, undefined, apiError);
    }

    return new KCError('unknown', apiError.message, undefined, apiError);
  }
}
