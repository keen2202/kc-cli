import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  classifyApiError,
  classifyToolError,
  getRetryDelay,
  RetryState,
} from '../../src/services/error-classifier';

describe('classifyApiError', () => {
  it('should classify rate limit as transient', () => {
    const result = classifyApiError(new Error('429 Too Many Requests'));
    expect(result.errorClass).toBe('transient');
    expect(result.retryable).toBe(true);
    expect(result.context).toBe('rate_limit');
    expect(result.retryAfterMs).toBe(5000);
  });

  it('should classify rate_limit keyword as transient', () => {
    const result = classifyApiError(new Error('rate_limit exceeded'));
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('rate_limit');
  });

  it('should classify rate limit (two words) as transient', () => {
    const result = classifyApiError(new Error('rate limit exceeded'));
    expect(result.context).toBe('rate_limit');
  });

  it('should classify 500 as transient server error', () => {
    const result = classifyApiError(new Error('500 Internal Server Error'));
    expect(result.errorClass).toBe('transient');
    expect(result.retryable).toBe(true);
    expect(result.context).toBe('server_error');
    expect(result.retryAfterMs).toBe(1000);
  });

  it('should classify 502 as transient', () => {
    expect(classifyApiError(new Error('502 Bad Gateway')).context).toBe('server_error');
  });

  it('should classify 503 as transient', () => {
    expect(classifyApiError(new Error('503 Service Unavailable')).context).toBe('server_error');
  });

  it('should classify 529 as transient', () => {
    expect(classifyApiError(new Error('529 Overloaded')).context).toBe('server_error');
  });

  it('should classify overloaded as transient', () => {
    const result = classifyApiError(new Error('API overloaded'));
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('overloaded');
    expect(result.retryAfterMs).toBe(3000);
  });

  it('should classify timeout as transient', () => {
    const result = classifyApiError(new Error('Request timeout'));
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('timeout');
  });

  it('should classify timed out as transient', () => {
    expect(classifyApiError(new Error('Connection timed out')).context).toBe('timeout');
  });

  it('should classify ETIMEDOUT as transient', () => {
    expect(classifyApiError(new Error('ETIMEDOUT')).context).toBe('timeout');
  });

  it('should classify ECONNRESET as transient network', () => {
    const result = classifyApiError(new Error('ECONNRESET'));
    expect(result.errorClass).toBe('transient');
    expect(result.context).toBe('network');
  });

  it('should classify ECONNREFUSED as transient', () => {
    expect(classifyApiError(new Error('ECONNREFUSED')).context).toBe('network');
  });

  it('should classify fetch failed as transient', () => {
    expect(classifyApiError(new Error('fetch failed')).context).toBe('network');
  });

  it('should classify 401 as permanent auth error', () => {
    const result = classifyApiError(new Error('401 Unauthorized'));
    expect(result.errorClass).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.context).toBe('auth');
  });

  it('should classify 403 as permanent auth error', () => {
    expect(classifyApiError(new Error('403 Forbidden')).context).toBe('auth');
  });

  it('should classify invalid_api_key as permanent auth error', () => {
    expect(classifyApiError(new Error('invalid_api_key')).context).toBe('auth');
  });

  it('should classify unauthorized as permanent auth error', () => {
    expect(classifyApiError(new Error('unauthorized access')).context).toBe('auth');
  });

  it('should classify 400 as permanent bad request', () => {
    const result = classifyApiError(new Error('400 Bad Request'));
    expect(result.errorClass).toBe('permanent');
    expect(result.context).toBe('bad_request');
  });

  it('should classify invalid_request as permanent bad request', () => {
    expect(classifyApiError(new Error('invalid_request')).context).toBe('bad_request');
  });

  it('should classify tool errors as degraded', () => {
    const result = classifyApiError(new Error('tool execution error'));
    expect(result.errorClass).toBe('degraded');
    expect(result.retryable).toBe(false);
    expect(result.context).toBe('tool_error');
  });

  it('should classify tool failed as degraded', () => {
    expect(classifyApiError(new Error('tool failed')).context).toBe('tool_error');
  });

  it('should classify unknown errors as permanent', () => {
    const result = classifyApiError(new Error('something weird happened'));
    expect(result.errorClass).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.context).toBe('unknown');
  });
});

describe('classifyToolError', () => {
  it('should classify timeout as degraded', () => {
    const result = classifyToolError(new Error('timeout'), 'Bash');
    expect(result.errorClass).toBe('degraded');
    expect(result.retryable).toBe(false);
    expect(result.context).toBe('tool_timeout:Bash');
  });

  it('should classify timed out as degraded', () => {
    const result = classifyToolError(new Error('timed out'), 'FileRead');
    expect(result.context).toBe('tool_timeout:FileRead');
  });

  it('should classify permission denied as permanent', () => {
    const result = classifyToolError(new Error('permission denied'), 'Bash');
    expect(result.errorClass).toBe('permanent');
    expect(result.retryable).toBe(false);
    expect(result.context).toBe('permission_denied:Bash');
  });

  it('should classify other errors as degraded tool_failed', () => {
    const result = classifyToolError(new Error('something broke'), 'Grep');
    expect(result.errorClass).toBe('degraded');
    expect(result.context).toBe('tool_failed:Grep');
  });
});

describe('getRetryDelay', () => {
  it('should return exponential backoff with jitter', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // attempt 0: base=1000, delay=1000, jitter=0.5*0.3*1000=150, total=1150
    const delay0 = getRetryDelay(0, 1000);
    expect(delay0).toBeGreaterThanOrEqual(1000);
    expect(delay0).toBeLessThanOrEqual(1300);

    // attempt 1: delay=2000, jitter=0.5*0.3*2000=300, total=2300
    const delay1 = getRetryDelay(1, 1000);
    expect(delay1).toBeGreaterThanOrEqual(2000);
    expect(delay1).toBeLessThanOrEqual(2600);

    // attempt 2: delay=4000, jitter=0.5*0.3*4000=600, total=4600
    const delay2 = getRetryDelay(2, 1000);
    expect(delay2).toBeGreaterThanOrEqual(4000);
    expect(delay2).toBeLessThanOrEqual(5200);

    vi.restoreAllMocks();
  });

  it('should use default base delay', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const delay = getRetryDelay(0);
    expect(delay).toBe(1000);
    vi.restoreAllMocks();
  });
});

describe('RetryState', () => {
  let retryState: RetryState;

  beforeEach(() => {
    retryState = new RetryState();
  });

  it('should start with 0 attempts', () => {
    expect(retryState.getAttempt('key1')).toBe(0);
  });

  it('should increment attempts', () => {
    retryState.incrementAttempt('key1');
    expect(retryState.getAttempt('key1')).toBe(1);
    retryState.incrementAttempt('key1');
    expect(retryState.getAttempt('key1')).toBe(2);
  });

  it('should allow retry when under MAX_RETRIES', () => {
    expect(retryState.canRetry('key1')).toBe(true);
    retryState.incrementAttempt('key1');
    expect(retryState.canRetry('key1')).toBe(true);
    retryState.incrementAttempt('key1');
    expect(retryState.canRetry('key1')).toBe(true);
  });

  it('should deny retry at MAX_RETRIES (10)', () => {
    for (let i = 0; i < 10; i++) {
      retryState.incrementAttempt('key1');
    }
    expect(retryState.canRetry('key1')).toBe(false);
  });

  it('should reset specific key', () => {
    retryState.incrementAttempt('key1');
    retryState.incrementAttempt('key1');
    retryState.reset('key1');
    expect(retryState.getAttempt('key1')).toBe(0);
  });

  it('should reset all keys', () => {
    retryState.incrementAttempt('key1');
    retryState.incrementAttempt('key2');
    retryState.resetAll();
    expect(retryState.getAttempt('key1')).toBe(0);
    expect(retryState.getAttempt('key2')).toBe(0);
  });

  it('should track independent keys', () => {
    retryState.incrementAttempt('key1');
    retryState.incrementAttempt('key1');
    retryState.incrementAttempt('key2');
    expect(retryState.getAttempt('key1')).toBe(2);
    expect(retryState.getAttempt('key2')).toBe(1);
  });
});
