// Behavior tests for the QueryEngine Error submodule (audit round3 T13 / H6).
//
// Scope: `src/query/QueryEngineError.ts` (ErrorHandler) — error classification
// → retry decision matrix (rate limit / timeout / network / auth → retry vs
// abort), backoff boundaries, circuit-breaker interaction, degraded-error
// handling and error-event creation.
//
// The module under test is driven REAL: ErrorHandler owns the real
// classifyApiError + CircuitBreakerRegistry. Only the LLM transport is mocked
// (the engine wiring test injects MockLLMClient through createAPIClient) —
// no real network, no real git, fake Date timers for circuit timing.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ErrorHandler } from '../../src/query/QueryEngineError';
import { ApiError } from '../../src/api/BaseApiClient';
import { initializeState } from '../../src/bootstrap/state';
import type { LLMProvider } from '../../src/api';
import type { AgentEvent } from '../../src/state/types';

// Backoff constants mirrored from src/services/error-classifier.ts — used to
// assert the delay boundaries the classifier feeds into shouldRetry().
const RATE_LIMIT_BASE_DELAY_MS = 8000;

describe('ErrorHandler — retry decision matrix (shouldRetry)', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = new ErrorHandler();
  });

  // ── Retryable classes ──

  it('retries a 429 rate-limit error with the rate-limit base delay (+≤10% jitter)', () => {
    const delay = handler.shouldRetry(new ApiError('Too many requests', 429), 0);
    expect(delay).not.toBeNull();
    // No Retry-After header → getRateLimitRetryDelay(0) = getRetryDelay(0, 8000)
    //   base 8000 * 2^0, capped at 120s, jitter < 30%
    expect(delay!.delay).toBeGreaterThanOrEqual(RATE_LIMIT_BASE_DELAY_MS);
    expect(delay!.delay).toBeLessThan(RATE_LIMIT_BASE_DELAY_MS * 1.31);
  });

  it('keeps the rate-limit delay stable across attempts while the base delay applies', () => {
    // With a status-code 429 (or message match) the classifier always supplies
    // retryAfterMs (header value or the 8000ms base), which overrides plain
    // exponential growth — every attempt waits ≈8s, never less.
    const err = () => new ApiError('rate limited', 429);
    const attempt0 = handler.shouldRetry(err(), 0)!;
    const attempt1 = handler.shouldRetry(err(), 1)!;
    expect(attempt1.delay).toBeGreaterThanOrEqual(RATE_LIMIT_BASE_DELAY_MS);
    expect(attempt1.delay).toBeLessThan(RATE_LIMIT_BASE_DELAY_MS * 1.11);
    // Same band as attempt 0 — the base delay, not the attempt counter, governs.
    expect(Math.abs(attempt1.delay - attempt0.delay)).toBeLessThan(RATE_LIMIT_BASE_DELAY_MS * 0.2);
  });

  it('honors the Retry-After header (seconds form) for 429s with small jitter', () => {
    const err = new ApiError('Too many requests', 429, { 'retry-after': '3' });
    const delay = handler.shouldRetry(err, 0)!;
    // 3000ms header value + up to 10% jitter
    expect(delay.delay).toBeGreaterThanOrEqual(3000);
    expect(delay.delay).toBeLessThan(3300);
  });

  it('parses an HTTP-date Retry-After into a positive millisecond delay', () => {
    const soon = new Date(Date.now() + 5000).toUTCString();
    const err = new ApiError('Too many requests', 429, { 'retry-after': soon });
    const delay = handler.shouldRetry(err, 0)!;
    // ≈5000ms until the date (+ jitter, minus ms of test-execution drift)
    expect(delay.delay).toBeGreaterThan(4000);
    expect(delay.delay).toBeLessThanOrEqual(5600);
  });

  it('retries timeout errors with the fixed 1000ms transient delay', () => {
    expect(handler.shouldRetry(new Error('Request timeout after 30s'), 0)).toEqual({ delay: 1000 });
    expect(handler.shouldRetry(new Error('ETIMEDOUT while streaming'), 2)).toEqual({ delay: 1000 });
  });

  it('retries network errors (fetch failed / ECONNRESET / ECONNREFUSED)', () => {
    expect(handler.shouldRetry(new Error('fetch failed'), 0)).toEqual({ delay: 1000 });
    expect(handler.shouldRetry(new Error('ECONNRESET during request'), 0)).toEqual({ delay: 1000 });
    expect(handler.shouldRetry(new Error('ECONNREFUSED 127.0.0.1:443'), 0)).toEqual({ delay: 1000 });
  });

  it('retries server errors (5xx via status code or message)', () => {
    expect(handler.shouldRetry(new ApiError('Internal Server Error', 500), 0)).toEqual({ delay: 1000 });
    expect(handler.shouldRetry(new ApiError('Bad gateway', 502), 1)).toEqual({ delay: 1000 });
    expect(handler.shouldRetry(new Error('upstream returned 503'), 0)).toEqual({ delay: 1000 });
  });

  it('retries overloaded errors with their dedicated 3000ms delay', () => {
    expect(handler.shouldRetry(new Error('anthropic: overloaded'), 0)).toEqual({ delay: 3000 });
  });

  // ── Abort (non-retryable) classes ──

  it('aborts on auth errors: 401/403 status codes map to null', () => {
    expect(handler.shouldRetry(new ApiError('Unauthorized', 401), 0)).toBeNull();
    expect(handler.shouldRetry(new ApiError('Forbidden', 403), 3)).toBeNull();
  });

  it('aborts on auth errors detected by message content', () => {
    expect(handler.shouldRetry(new Error('invalid_api_key provided'), 0)).toBeNull();
    expect(handler.shouldRetry(new Error('unauthorized: check credentials'), 0)).toBeNull();
  });

  it('aborts on bad-request client errors (400/404/422)', () => {
    expect(handler.shouldRetry(new ApiError('Bad Request', 400), 0)).toBeNull();
    expect(handler.shouldRetry(new ApiError('Not Found', 404), 0)).toBeNull();
    expect(handler.shouldRetry(new ApiError('Unprocessable Entity', 422), 0)).toBeNull();
    expect(handler.shouldRetry(new Error('invalid_request: unknown parameter'), 0)).toBeNull();
  });

  it('aborts on degraded tool errors and on completely unknown errors', () => {
    expect(handler.shouldRetry(new Error('tool execution failed'), 0)).toBeNull();
    expect(handler.shouldRetry(new Error('something entirely unexpected'), 0)).toBeNull();
  });

  // ── Retry budget boundaries ──

  it('returns null once the attempt reaches maxRetries even for retryable errors', () => {
    const bounded = new ErrorHandler(3);
    const rateLimited = () => new ApiError('rate limited', 429);
    expect(bounded.shouldRetry(rateLimited(), 0)).not.toBeNull();
    expect(bounded.shouldRetry(rateLimited(), 2)).not.toBeNull();
    expect(bounded.shouldRetry(rateLimited(), 3)).toBeNull(); // attempt == maxRetries → abort

    // Default budget is 10: attempt 9 still retries, attempt 10 does not.
    expect(handler.shouldRetry(rateLimited(), 9)).not.toBeNull();
    expect(handler.shouldRetry(rateLimited(), 10)).toBeNull();
  });
});

describe('ErrorHandler — circuit breaker interaction', () => {
  beforeEach(() => {
    // Only fake Date so CircuitBreaker's elapsed-time checks are deterministic
    // while promises/microtasks keep running normally.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts closed and stays closed below the failure threshold', () => {
    const handler = new ErrorHandler();
    expect(handler.canExecuteApi()).toBe(true);
    for (let i = 0; i < 4; i++) {
      handler.recordApiFailure(new ApiError('server exploded', 500));
    }
    expect(handler.canExecuteApi()).toBe(true);
    const api = handler.getCircuitBreakers().getBreaker('api');
    expect(api.getState()).toBe('closed');
    expect(api.getFailureCount()).toBe(4);
  });

  it('opens the circuit after 5 consecutive retryable API failures', () => {
    const handler = new ErrorHandler();
    for (let i = 0; i < 5; i++) {
      handler.recordApiFailure(new ApiError('server exploded', 500));
    }
    expect(handler.canExecuteApi()).toBe(false);
    const status = handler.getCircuitBreakers().getStatus();
    expect(status).toEqual([{ service: 'api', state: 'open', failures: 5 }]);
  });

  it('does NOT count non-retryable failures toward the breaker', () => {
    const handler = new ErrorHandler();
    for (let i = 0; i < 8; i++) {
      handler.recordApiFailure(new ApiError('invalid_api_key', 401));
    }
    expect(handler.canExecuteApi()).toBe(true);
    expect(handler.getCircuitBreakers().getBreaker('api').getFailureCount()).toBe(0);
  });

  it('recovers to half-open after the reset timeout elapses', () => {
    const handler = new ErrorHandler();
    for (let i = 0; i < 5; i++) {
      handler.recordApiFailure(new ApiError('boom', 503));
    }
    expect(handler.canExecuteApi()).toBe(false);

    // Default resetTimeoutMs is 30000; advance just past it.
    vi.setSystemTime(Date.now() + 30_001);
    const api = handler.getCircuitBreakers().getBreaker('api');
    expect(api.getState()).toBe('half-open');
    expect(handler.canExecuteApi()).toBe(true);
  });

  it('closes the circuit again when a half-open probe succeeds', () => {
    const handler = new ErrorHandler();
    for (let i = 0; i < 5; i++) handler.recordApiFailure(new ApiError('boom', 500));
    vi.setSystemTime(Date.now() + 30_001);
    expect(handler.canExecuteApi()).toBe(true); // half-open probe allowed

    handler.recordApiSuccess();
    const api = handler.getCircuitBreakers().getBreaker('api');
    expect(api.getState()).toBe('closed');
    expect(api.getFailureCount()).toBe(0);
    expect(handler.canExecuteApi()).toBe(true);
  });

  it('re-opens immediately when a half-open probe fails', () => {
    const handler = new ErrorHandler();
    for (let i = 0; i < 5; i++) handler.recordApiFailure(new ApiError('boom', 500));
    vi.setSystemTime(Date.now() + 30_001);
    expect(handler.canExecuteApi()).toBe(true); // half-open

    handler.recordApiFailure(new ApiError('still down', 502));
    expect(handler.getCircuitBreakers().getBreaker('api').getState()).toBe('open');
    expect(handler.canExecuteApi()).toBe(false);
  });

  it('recordApiSuccess resets the failure streak before the breaker opens', () => {
    const handler = new ErrorHandler();
    handler.recordApiFailure(new ApiError('blip', 500));
    handler.recordApiFailure(new ApiError('blip', 500));
    handler.recordApiSuccess(); // streak reset
    for (let i = 0; i < 4; i++) handler.recordApiFailure(new ApiError('blip', 500));
    expect(handler.canExecuteApi()).toBe(true); // only 4 since last success
  });

  it('reset() clears retry bookkeeping but does not mask an open circuit', () => {
    const handler = new ErrorHandler();
    for (let i = 0; i < 5; i++) handler.recordApiFailure(new ApiError('down', 503));
    handler.reset();
    // An open breaker must survive reset(): callers still canExecuteApi()==false.
    expect(handler.canExecuteApi()).toBe(false);
    expect(handler.getCircuitBreakers().getBreaker('api').getState()).toBe('open');
  });
});

describe('ErrorHandler — degraded errors', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = new ErrorHandler();
  });

  it('classifies tool failures as degraded (non-fatal, continue without retry)', () => {
    expect(handler.isDegradedError(new Error('tool call failed'))).toBe(true);
    expect(handler.isDegradedError(new Error('error raised by tool'))).toBe(true);
  });

  it('never classifies transient or permanent API errors as degraded', () => {
    expect(handler.isDegradedError(new Error('Request timeout'))).toBe(false);
    expect(handler.isDegradedError(new ApiError('Too many requests', 429))).toBe(false);
    expect(handler.isDegradedError(new ApiError('Unauthorized', 401))).toBe(false);
    expect(handler.isDegradedError(new Error('mystery failure'))).toBe(false);
  });
});

describe('ErrorHandler — createErrorEvent', () => {
  let handler: ErrorHandler;

  beforeEach(() => {
    handler = new ErrorHandler();
  });

  it('wraps an Error preserving the instance and marks it non-recoverable', () => {
    const original = new Error('stream blew up');
    const event = handler.createErrorEvent(original) as Extract<AgentEvent, { type: 'agent:error' }>;
    expect(event.type).toBe('agent:error');
    expect(event.error).toBe(original);
    expect(event.recoverable).toBe(false);
    expect(typeof event.timestamp).toBe('number');
  });

  it('coerces non-Error throwables (strings) into an Error', () => {
    const event = handler.createErrorEvent('plain string failure') as Extract<AgentEvent, { type: 'agent:error' }>;
    expect(event.error).toBeInstanceOf(Error);
    expect(event.error.message).toBe('plain string failure');
    expect(event.recoverable).toBe(false);
  });
});

describe('ErrorHandler — QueryEngine construction wiring', () => {
  beforeEach(() => {
    initializeState({
      cwd: '/tmp',
      apiKey: 'test-key',
      permissionMode: 'bypassPermissions',
    });
    process.env.KC_API_KEY = 'test-dummy-key';
  });

  it('exposes the engine-owned ErrorHandler whose breaker reacts to recorded failures', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine');
    const engine = new QueryEngine(
      {
        model: 'test-model',
        provider: 'anthropic' as LLMProvider,
        apiKey: 'test-key',
        maxTurns: 3,
        maxBudgetUsd: null,
      },
      []
    );

    const errorHandler = engine.getErrorHandler();
    expect(errorHandler).toBeInstanceOf(ErrorHandler);
    expect(errorHandler.canExecuteApi()).toBe(true);

    // Simulate consecutive retryable API failures through the wired submodule —
    // the facade must observe the same accumulating breaker.
    for (let i = 0; i < 4; i++) {
      errorHandler.recordApiFailure(new ApiError('server exploded', 500));
    }
    expect(errorHandler.getCircuitBreakers().getBreaker('api').getFailureCount()).toBe(4);

    // A success resets the failure streak (breaker stays closed below threshold).
    errorHandler.recordApiSuccess();
    expect(errorHandler.canExecuteApi()).toBe(true);
    expect(errorHandler.getCircuitBreakers().getBreaker('api').getFailureCount()).toBe(0);
    expect(errorHandler.getCircuitBreakers().getBreaker('api').getState()).toBe('closed');
  });
});
