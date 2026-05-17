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
  if (message.includes('429') || message.includes('rate_limit') || message.includes('rate limit')) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 2000, context: 'rate_limit' };
  }

  // Transient: server error
  if (message.includes('500') || message.includes('502') || message.includes('503') || message.includes('529')) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 1000, context: 'server_error' };
  }

  // Transient: overloaded
  if (message.includes('overloaded')) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 3000, context: 'overloaded' };
  }

  // Transient: timeout
  if (message.includes('timeout') || message.includes('timed out') || message.includes('etimedout')) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 1000, context: 'timeout' };
  }

  // Transient: network errors
  if (message.includes('econnreset') || message.includes('econnrefused') || message.includes('fetch failed')) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 1000, context: 'network' };
  }

  // Permanent: auth errors
  if (message.includes('401') || message.includes('403') || message.includes('invalid_api_key') || message.includes('unauthorized')) {
    return { error, errorClass: 'permanent', retryable: false, context: 'auth' };
  }

  // Permanent: bad request
  if (message.includes('400') || message.includes('invalid_request')) {
    return { error, errorClass: 'permanent', retryable: false, context: 'bad_request' };
  }

  // Degraded: tool errors (continue execution, mark tool as failed)
  if (message.includes('tool') && (message.includes('error') || message.includes('failed'))) {
    return { error, errorClass: 'degraded', retryable: false, context: 'tool_error' };
  }

  // Default: permanent (don't retry unknown errors)
  return { error, errorClass: 'permanent', retryable: false, context: 'unknown' };
}

export function classifyToolError(error: Error, toolName: string): ClassifiedError {
  const message = error.message.toLowerCase();

  // Degraded: tool timeout
  if (message.includes('timeout') || message.includes('timed out')) {
    return { error, errorClass: 'degraded', retryable: false, context: `tool_timeout:${toolName}` };
  }

  // Permanent: permission denied
  if (message.includes('permission') && message.includes('denied')) {
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
