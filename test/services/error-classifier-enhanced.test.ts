import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyApiError, RetryState } from '../../src/services/error-classifier';
import { ApiError } from '../../src/api/BaseApiClient';

describe('classifyApiError with ApiError (HTTP status codes)', () => {
  it('should classify HTTP 429 as transient rate_limit', () => {
    const error = new ApiError('Rate limited', 429);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('transient');
    expect(result.retryable).toBe(true);
    expect(result.context).toBe('rate_limit');
    expect(result.retryAfterMs).toBe(8000);
  });

  it('should extract Retry-After header in seconds', () => {
    const error = new ApiError('Rate limited', 429, { 'retry-after': '5' });
    const result = classifyApiError(error);
    expect(result.retryAfterMs).toBe(5000);
  });

  it('should extract Retry-After header as HTTP-date', () => {
    const futureDate = new Date(Date.now() + 10000).toUTCString();
    const error = new ApiError('Rate limited', 429, { 'retry-after': futureDate });
    const result = classifyApiError(error);
    expect(result.retryAfterMs).toBeGreaterThanOrEqual(9000);
    expect(result.retryAfterMs).toBeLessThanOrEqual(11000);
  });

  it('should classify HTTP 500 as transient server_error', () => {
    const error = new ApiError('Internal server error', 500);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('transient');
    expect(result.retryable).toBe(true);
    expect(result.context).toBe('server_error');
    expect(result.retryAfterMs).toBe(1000);
  });

  it('should classify HTTP 502 as transient server_error', () => {
    const error = new ApiError('Bad gateway', 502);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('server_error');
  });

  it('should classify HTTP 503 as transient server_error', () => {
    const error = new ApiError('Service unavailable', 503);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('server_error');
  });

  it('should classify HTTP 509 as transient server_error', () => {
    const error = new ApiError('Bandwidth limit exceeded', 509);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('server_error');
  });

  it('should classify HTTP 401 as permanent auth', () => {
    const error = new ApiError('Unauthorized', 401);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.context).toBe('auth');
  });

  it('should classify HTTP 403 as permanent auth', () => {
    const error = new ApiError('Forbidden', 403);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('permanent');
    expect(result.context).toBe('auth');
  });

  it('should classify HTTP 400 as permanent bad_request', () => {
    const error = new ApiError('Bad request', 400);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('permanent');
    expect(result.context).toBe('bad_request');
  });

  it('should classify HTTP 404 as permanent bad_request', () => {
    const error = new ApiError('Not found', 404);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('permanent');
    expect(result.context).toBe('bad_request');
  });

  it('should classify HTTP 422 as permanent bad_request', () => {
    const error = new ApiError('Unprocessable entity', 422);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('permanent');
    expect(result.context).toBe('bad_request');
  });

  it('should fall back to string matching for non-ApiError', () => {
    const error = new Error('429 Too Many Requests');
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('rate_limit');
  });

  it('should fall back to string matching for ApiError without statusCode', () => {
    const error = new ApiError('rate_limit exceeded');
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('rate_limit');
  });

  it('should prefer HTTP status code over string matching', () => {
    // Message says 500 but status code says 429
    const error = new ApiError('500 Internal Server Error', 429);
    const result = classifyApiError(error);
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('rate_limit');
  });

  it('should handle lowercase retry-after header (as normalized by handleApiError)', () => {
    const error = new ApiError('Rate limited', 429, { 'retry-after': '3' });
    const result = classifyApiError(error);
    expect(result.retryAfterMs).toBe(3000);
  });
});

describe('RetryState reset on success', () => {
  let retryState: RetryState;

  beforeEach(() => {
    retryState = new RetryState();
  });

  it('should reset attempt counter on success', () => {
    retryState.incrementAttempt('streaming');
    retryState.incrementAttempt('streaming');
    expect(retryState.getAttempt('streaming')).toBe(2);

    retryState.reset('streaming');
    expect(retryState.getAttempt('streaming')).toBe(0);
  });

  it('should allow retry again after reset', () => {
    for (let i = 0; i < 10; i++) retryState.incrementAttempt('streaming');
    expect(retryState.canRetry('streaming')).toBe(false);

    retryState.reset('streaming');
    expect(retryState.canRetry('streaming')).toBe(true);
  });

  it('should only reset the specified key', () => {
    retryState.incrementAttempt('streaming');
    retryState.incrementAttempt('compaction');

    retryState.reset('streaming');

    expect(retryState.getAttempt('streaming')).toBe(0);
    expect(retryState.getAttempt('compaction')).toBe(1);
  });
});
