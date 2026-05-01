// Error classification and retry logic

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

export function classifyApiError(error: Error): ClassifiedError {
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
  if (message.includes('timeout') || message.includes('timed out') || message.includes('ETIMEDOUT')) {
    return { error, errorClass: 'transient', retryable: true, retryAfterMs: 1000, context: 'timeout' };
  }

  // Transient: network errors
  if (message.includes('ECONNRESET') || message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
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
