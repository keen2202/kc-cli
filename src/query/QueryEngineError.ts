// QueryEngine error handling and circuit breaker management

import { classifyApiError, getRateLimitRetryDelay, getRetryDelay, RetryState } from '../services/error-classifier';
import { CircuitBreakerRegistry } from '../services/circuitBreaker';
import type { AgentEvent } from '../state/types';

/**
 * Manages error handling for QueryEngine.
 * Coordinates circuit breakers, retry state, and error classification.
 */
export class ErrorHandler {
  private retryState = new RetryState();
  private circuitBreakers = new CircuitBreakerRegistry();
  private maxRetries: number;

  constructor(maxRetries: number = 10) {
    this.maxRetries = maxRetries;
  }

  /** Get the circuit breaker registry */
  getCircuitBreakers(): CircuitBreakerRegistry {
    return this.circuitBreakers;
  }

  /** Check if an API call can proceed (circuit breaker not open) */
  canExecuteApi(): boolean {
    const breaker = this.circuitBreakers.getBreaker('api');
    return breaker.canExecute();
  }

  /** Record a successful API call */
  recordApiSuccess(): void {
    this.circuitBreakers.getBreaker('api').recordSuccess();
    this.retryState.reset('streaming');
  }

  /** Record a failed API call */
  recordApiFailure(error: Error): void {
    const classified = classifyApiError(error);
    if (classified.retryable) {
      this.circuitBreakers.getBreaker('api').recordFailure();
    }
  }

  /**
   * Determine if an error is retryable and within retry limits.
   * Returns retry info or null if retry should not be attempted.
   */
  shouldRetry(error: Error, attempt: number): { delay: number } | null {
    if (attempt >= this.maxRetries) return null;

    const classified = classifyApiError(error);
    if (!classified.retryable) return null;

    // Use rate-limit-specific delay for 429 errors, respecting Retry-After header
    const delay = classified.context === 'rate_limit'
      ? getRateLimitRetryDelay(attempt, classified.retryAfterMs)
      : (classified.retryAfterMs ?? getRetryDelay(attempt));
    return { delay };
  }

  /** Check if error is a degraded error (non-fatal, continue without retrying) */
  isDegradedError(error: Error): boolean {
    return classifyApiError(error).errorClass === 'degraded';
  }

  /** Create a generic error event */
  createErrorEvent(error: unknown): AgentEvent {
    return {
      type: 'agent:error',
      error: error instanceof Error ? error : new Error(String(error)),
      recoverable: false,
      timestamp: Date.now(),
    };
  }

  /** Reset error handling state */
  reset(): void {
    this.retryState = new RetryState();
  }
}
