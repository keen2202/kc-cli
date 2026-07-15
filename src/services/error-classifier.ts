// Error classification and retry logic

import { ApiError } from '../api/BaseApiClient';

export type ErrorClass = 'transient' | 'permanent' | 'degraded';

export interface ClassifiedError {
  error: Error;
  errorClass: ErrorClass;
  retryable: boolean;
  retryAfterMs?: number;
  context: string;
}

export interface EnhancedClassifiedError extends ClassifiedError {
  toolCallId?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
  repairSuggestion?: string;
}

const MAX_RETRIES = 8;
const BASE_DELAY_MS = 2000;
const RATE_LIMIT_BASE_DELAY_MS = 8000;
const MAX_BACKOFF_MS = 120_000;

// Pre-compiled regex patterns for error classification (single test instead of multiple includes())
// All HTTP status code patterns use \b word boundaries to prevent false matches
// inside longer numeric strings (T044).
const RATE_LIMIT_REGEX = /\b429\b|rate.?limit/;
const SERVER_ERROR_REGEX = /\b(?:500|502|503|529)\b/;
const OVERLOADED_REGEX = /overloaded/;
const TIMEOUT_REGEX = /timeout|timed\s*out|etimedout/;
const NETWORK_ERROR_REGEX = /econnreset|econnrefused|fetch\s*failed/;
const AUTH_ERROR_REGEX = /\b(?:401|403)\b|invalid_api_key|unauthorized/;
const BAD_REQUEST_REGEX = /\b400\b|invalid_request/;
const TOOL_ERROR_REGEX = /tool.*(error|failed)|(error|failed).*tool/;
const TOOL_TIMEOUT_REGEX = /timeout|timed\s*out/;
const PERMISSION_DENIED_REGEX = /permission.*denied|denied.*permission/;

/**
 * Extract retry-after delay in milliseconds from Retry-After header value.
 * Supports both seconds (e.g., "2") and HTTP-date formats.
 */
function parseRetryAfterMs(headerValue: string): number | undefined {
  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  // Try HTTP-date format
  const date = new Date(headerValue);
  if (!Number.isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? ms : 0;
  }
  return undefined;
}

/**
 * Classify an API error for retry decisions.
 * First checks for ApiError with HTTP status code, then falls back to string matching.
 */
export function classifyApiError(error: Error): ClassifiedError {
  // Primary: HTTP status code classification (when ApiError is available)
  if (error instanceof ApiError && error.statusCode !== undefined) {
    const status = error.statusCode;
    const retryAfter = error.responseHeaders?.['retry-after']
      ? parseRetryAfterMs(error.responseHeaders['retry-after'])
      : undefined;

    // 429: rate limited
    if (status === 429) {
      return { error, errorClass: 'transient', retryable: true, retryAfterMs: retryAfter ?? RATE_LIMIT_BASE_DELAY_MS, context: 'rate_limit' };
    }

    // 500-509: server errors (transient)
    if (status >= 500 && status <= 509) {
      return { error, errorClass: 'transient', retryable: true, retryAfterMs: retryAfter ?? 1000, context: 'server_error' };
    }

    // 401, 403: auth errors (permanent)
    if (status === 401 || status === 403) {
      return { error, errorClass: 'permanent', retryable: false, context: 'auth' };
    }

    // 400: check for transient malformed request errors (e.g., mimo "missing function name")
    if (status === 400) {
      const body = error.message.toLowerCase();
      if (body.includes('missing') && body.includes('function name')) {
        return { error, errorClass: 'transient', retryable: true, retryAfterMs: 2000, context: 'malformed_tool_call' };
      }
      return { error, errorClass: 'permanent', retryable: false, context: 'bad_request' };
    }

    // 404, 422: client errors (permanent)
    if (status >= 401 && status < 500) {
      return { error, errorClass: 'permanent', retryable: false, context: 'bad_request' };
    }
  }

  // Fallback: string matching for non-ApiError or errors without status code
  const message = error.message.toLowerCase();

  // Transient: rate limit
  if (RATE_LIMIT_REGEX.test(message)) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: RATE_LIMIT_BASE_DELAY_MS, context: 'rate_limit' };
  }

  // Transient: server error
  if (SERVER_ERROR_REGEX.test(message)) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 1000, context: 'server_error' };
  }

  // Transient: overloaded
  if (OVERLOADED_REGEX.test(message)) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 3000, context: 'overloaded' };
  }

  // Transient: timeout
  if (TIMEOUT_REGEX.test(message)) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 1000, context: 'timeout' };
  }

  // Transient: network errors
  if (NETWORK_ERROR_REGEX.test(message)) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 1000, context: 'network' };
  }

  // Permanent: auth errors
  if (AUTH_ERROR_REGEX.test(message)) {
    return { error, errorClass: 'permanent', retryable: false, context: 'auth' };
  }

  // Transient: malformed tool call (mimo API quirk - model sometimes sends empty function name)
  if (message.includes('missing') && message.includes('function name')) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 2000, context: 'malformed_tool_call' };
  }

  // Permanent: bad request
  if (BAD_REQUEST_REGEX.test(message)) {
    return { error, errorClass: 'permanent', retryable: false, context: 'bad_request' };
  }

  // Degraded: tool errors (continue execution, mark tool as failed)
  if (TOOL_ERROR_REGEX.test(message)) {
    return { error, errorClass: 'degraded', retryable: false, context: 'tool_error' };
  }

  // Default: permanent (don't retry unknown errors)
  return { error, errorClass: 'permanent', retryable: false, context: 'unknown' };
}

export function classifyToolError(error: Error, toolName: string, toolCallId?: string): EnhancedClassifiedError {
  const message = error.message.toLowerCase();

  // Degraded: tool timeout
  if (TOOL_TIMEOUT_REGEX.test(message)) {
    return {
      error, errorClass: 'degraded', retryable: false,
      context: `tool_timeout:${toolName}`,
      toolCallId,
      actualBehavior: `Tool '${toolName}' exceeded execution time limit`,
      repairSuggestion: 'Increase timeout with KC_TOOL_TIMEOUT_MS, or break the task into smaller steps',
    };
  }

  // Permanent: permission denied
  if (PERMISSION_DENIED_REGEX.test(message)) {
    return {
      error, errorClass: 'permanent', retryable: false,
      context: `permission_denied:${toolName}`,
      toolCallId,
      actualBehavior: `Permission denied for tool '${toolName}'`,
      repairSuggestion: 'Check file permissions or add an allow rule in .kc-cli/settings.json',
    };
  }

  // File system errors
  if (message.includes('eacces') || message.includes('permission denied')) {
    return {
      error, errorClass: 'permanent', retryable: false,
      context: `permission_denied:${toolName}`,
      toolCallId,
      actualBehavior: 'File system permission denied',
      repairSuggestion: 'Check file/directory permissions or run with appropriate privileges',
    };
  }

  if (message.includes('enoent') || message.includes('no such file')) {
    return {
      error, errorClass: 'degraded', retryable: false,
      context: `file_not_found:${toolName}`,
      toolCallId,
      actualBehavior: 'File or directory not found',
      repairSuggestion: 'Verify the path exists and is spelled correctly',
    };
  }

  if (message.includes('enomem') || message.includes('out of memory')) {
    return {
      error, errorClass: 'degraded', retryable: false,
      context: `out_of_memory:${toolName}`,
      toolCallId,
      actualBehavior: 'Out of memory during tool execution',
      repairSuggestion: 'Reduce context size or split the task into smaller pieces',
    };
  }

  if (message.includes('syntaxerror') || message.includes('unexpected token')) {
    return {
      error, errorClass: 'degraded', retryable: false,
      context: `syntax_error:${toolName}`,
      toolCallId,
      actualBehavior: 'Syntax or parsing error in tool output',
      repairSuggestion: 'Check that the input format is valid JSON/text',
    };
  }

  // Degraded: tool execution failed (continue with other tools)
  return {
    error, errorClass: 'degraded', retryable: false,
    context: `tool_failed:${toolName}`,
    toolCallId,
  };
}

export function getRetryDelay(attemptNumber: number, baseMs: number = BASE_DELAY_MS): number {
  // Exponential backoff with jitter, capped at MAX_BACKOFF_MS
  const delay = Math.min(baseMs * Math.pow(2, attemptNumber), MAX_BACKOFF_MS);
  const jitter = Math.random() * 0.3 * delay;
  return Math.floor(delay + jitter);
}

/**
 * Get retry delay specifically for rate limit errors.
 * Uses higher base delay and longer cap to avoid hammering the API.
 */
export function getRateLimitRetryDelay(attemptNumber: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    // Respect Retry-After header with a small jitter
    const jitter = Math.random() * 0.1 * retryAfterMs;
    return Math.floor(retryAfterMs + jitter);
  }
  return getRetryDelay(attemptNumber, RATE_LIMIT_BASE_DELAY_MS);
}

export class RetryState {
  private attempts = new Map<string, number>();

  getAttempt(key: string): number {
    return this.attempts.get(key) || 0;
  }

  incrementAttempt(key: string): number {
    const current = this.getAttempt(key);
    this.attempts.set(key, current + 1);
    return current + 1;
  }

  canRetry(key: string): boolean {
    return this.getAttempt(key) < MAX_RETRIES;
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  resetAll(): void {
    this.attempts.clear();
  }
}
