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

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

// Pre-compiled regex patterns for error classification (single test instead of multiple includes())
const RATE_LIMIT_REGEX = /429|rate.?limit/;
const SERVER_ERROR_REGEX = /500|502|503|529/;
const OVERLOADED_REGEX = /overloaded/;
const TIMEOUT_REGEX = /timeout|timed\s*out|etimedout/;
const NETWORK_ERROR_REGEX = /econnreset|econnrefused|fetch\s*failed/;
const AUTH_ERROR_REGEX = /401|403|invalid_api_key|unauthorized/;
const BAD_REQUEST_REGEX = /400|invalid_request/;
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
      return { error, errorClass: 'transient', retryable: true, retryAfterMs: retryAfter ?? 2000, context: 'rate_limit' };
    }

    // 500-509: server errors (transient)
    if (status >= 500 && status <= 509) {
      return { error, errorClass: 'transient', retryable: true, retryAfterMs: retryAfter ?? 1000, context: 'server_error' };
    }

    // 401, 403: auth errors (permanent)
    if (status === 401 || status === 403) {
      return { error, errorClass: 'permanent', retryable: false, context: 'auth' };
    }

    // 400, 404, 422: client errors (permanent)
    if (status >= 400 && status < 500) {
      return { error, errorClass: 'permanent', retryable: false, context: 'bad_request' };
    }
  }

  // Fallback: string matching for non-ApiError or errors without status code
  const message = error.message.toLowerCase();

  // Transient: rate limit
  if (RATE_LIMIT_REGEX.test(message)) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 2000, context: 'rate_limit' };
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

export function classifyToolError(error: Error, toolName: string): ClassifiedError {
  const message = error.message.toLowerCase();

  // Degraded: tool timeout
  if (TOOL_TIMEOUT_REGEX.test(message)) {
    return { error, errorClass: 'degraded', retryable: false, context: `tool_timeout:${toolName}` };
  }

  // Permanent: permission denied
  if (PERMISSION_DENIED_REGEX.test(message)) {
    return { error, errorClass: 'permanent', retryable: false, context: `permission_denied:${toolName}` };
  }

  // Degraded: tool execution failed (continue with other tools)
  return { error, errorClass: 'degraded', retryable: false, context: `tool_failed:${toolName}` };
}

export function getRetryDelay(attemptNumber: number, baseMs: number = BASE_DELAY_MS): number {
  // Exponential backoff with jitter: 1s, 2s, 4s
  const delay = baseMs * Math.pow(2, attemptNumber);
  const jitter = Math.random() * 0.3 * delay;
  return Math.floor(delay + jitter);
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
