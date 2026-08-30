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
 * True when a rejection came from an AbortSignal rather than from the work
 * itself. Node reports it as `name === 'AbortError'`; the promisified
 * `child_process.exec` additionally surfaces the `ABORT_ERR` code, so both are
 * accepted. round4 §3-R7: a cancellation must never be reported as a failure.
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'AbortError' || candidate.code === 'ABORT_ERR';
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
  // Error-like plain objects (e.g. deserialized errors) carry a message field.
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string') return msg;
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
  | 'evaluation_incomparable'
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

/**
 * Actionable, user-facing suggestion for every ErrorCode.
 * Consumed by formatUserFacingError so any surfaced error carries both a
 * stable code and a concrete next step (never a silent or bare failure).
 */
export const ERROR_CODE_SUGGESTIONS: Record<ErrorCode, string> = {
  api_rate_limit: 'Rate limited by the provider. Wait a moment and retry, or switch model/provider via /model.',
  api_auth_failed: 'Authentication failed. Check the API key env var (e.g. KC_API_KEY / provider-specific key) and account access.',
  api_bad_request: 'The request was rejected by the provider. Check model name and input size, then retry.',
  api_server_error: 'Provider/server error or network failure. Check your network connection and retry; if it persists, switch provider.',
  api_timeout: 'The API call timed out. Check network connectivity/proxy settings and retry; consider a smaller request.',
  tool_not_found: 'The requested tool does not exist. Run /tools to list available tools.',
  tool_timeout: 'Tool execution timed out. Retry with a larger timeout or narrow the operation scope.',
  tool_permission_denied: 'Permission denied for this tool. Adjust permission mode (/mode) or approve the request when prompted.',
  tool_execution_failed: 'Tool execution failed. Check the tool arguments and the error output above, then retry.',
  compaction_failed: 'Context compaction failed. Retry, or use /clear to start a fresh conversation.',
  compaction_timeout: 'Context compaction timed out. Retry, or use /clear to reduce context size.',
  state_invalid_transition: 'Internal state transition error. Retry the request; if it persists, restart kc-cli and report the issue.',
  state_machine_error: 'Internal state machine error. Restart kc-cli; enable LOG_LEVEL=debug to capture details.',
  sandbox_unavailable: 'No sandbox backend available. Install Docker/bubblewrap, or set sandbox.failIfNoSandbox=false / backend "noop" in settings.',
  sandbox_denied: 'Sandbox policy denied this command. Adjust the sandbox policy in .kc-cli/settings.json or run a safer command.',
  session_not_found: 'Session not found. Use /session to list sessions or start a new one.',
  budget_exceeded: 'Token/cost budget exceeded. Raise the budget limit in settings or start a new session.',
  model_no_patch: 'The model finished without producing changes. Rephrase the task with concrete file targets and retry.',
  evaluation_incomparable: 'Evaluation results are not comparable. Re-run the evaluation with a consistent baseline.',
  unknown: 'Unexpected error. Retry; run with LOG_LEVEL=debug for details and report if it persists.',
};

/** Get the actionable suggestion for an error code. */
export function getErrorSuggestion(code: ErrorCode): string {
  return ERROR_CODE_SUGGESTIONS[code] ?? ERROR_CODE_SUGGESTIONS.unknown;
}

/**
 * Best-effort classification of an arbitrary error into an ErrorCode.
 * KCError keeps its own code; plain errors are matched on common
 * network/timeout/permission signatures.
 */
export function classifyErrorCode(error: unknown): ErrorCode {
  if (error instanceof KCError) return error.code;
  const msg = getErrorMessage(error).toLowerCase();
  if (/rate.?limit|\b429\b/.test(msg)) return 'api_rate_limit';
  if (/unauthorized|forbidden|invalid.?api.?key|\b401\b|\b403\b|auth/.test(msg)) return 'api_auth_failed';
  if (/timed?.?out|timeout|etimedout/.test(msg)) return 'api_timeout';
  if (/econnrefused|econnreset|enotfound|eai_again|network|fetch failed|socket hang up|\b5\d\d\b|server error/.test(msg)) {
    return 'api_server_error';
  }
  if (/permission denied|eacces|eperm/.test(msg)) return 'tool_permission_denied';
  if (/sandbox.*(unavailable|not available|no sandbox)/.test(msg)) return 'sandbox_unavailable';
  if (/budget/.test(msg)) return 'budget_exceeded';
  return 'unknown';
}

/**
 * Format any error for direct user display: `[code] message — Suggestion: ...`.
 * Guarantees the user always sees a stable error code plus an actionable fix,
 * regardless of where the error originated.
 */
export function formatUserFacingError(error: unknown): string {
  const code = classifyErrorCode(error);
  const message = getErrorMessage(error) || 'Unknown error';
  return `[${code}] ${message} — Suggestion: ${getErrorSuggestion(code)}`;
}
