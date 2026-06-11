import { describe, it, expect } from 'vitest';
import { KCError, isExecError, getErrorMessage, getErrorStack } from '../../src/utils/errors';
import type { ErrorCode } from '../../src/utils/errors';
import { ApiError } from '../../src/api/BaseApiClient';

describe('KCError', () => {
  describe('construction', () => {
    it('should create a KCError with code and message', () => {
      const error = new KCError('unknown', 'something went wrong');
      expect(error.code).toBe('unknown');
      expect(error.message).toBe('something went wrong');
      expect(error.name).toBe('KCError');
    });

    it('should be instanceof Error', () => {
      const error = new KCError('unknown', 'test');
      expect(error instanceof Error).toBe(true);
    });

    it('should be instanceof KCError', () => {
      const error = new KCError('unknown', 'test');
      expect(error instanceof KCError).toBe(true);
    });

    it('should preserve context', () => {
      const context = { statusCode: 429, retryAfter: 5 };
      const error = new KCError('api_rate_limit', 'rate limited', context);
      expect(error.context).toEqual(context);
    });

    it('should preserve cause', () => {
      const cause = new Error('original error');
      const error = new KCError('unknown', 'wrapped', undefined, cause);
      expect(error.cause).toBe(cause);
    });

    it('should allow undefined context and cause', () => {
      const error = new KCError('unknown', 'minimal');
      expect(error.context).toBeUndefined();
      expect(error.cause).toBeUndefined();
    });

    it('should have a stack trace', () => {
      const error = new KCError('unknown', 'test');
      expect(error.stack).toBeDefined();
      expect(error.stack).toContain('KCError');
    });
  });

  describe('all error codes', () => {
    const allCodes: ErrorCode[] = [
      'api_rate_limit',
      'api_auth_failed',
      'api_bad_request',
      'api_server_error',
      'api_timeout',
      'tool_not_found',
      'tool_timeout',
      'tool_permission_denied',
      'tool_execution_failed',
      'compaction_failed',
      'compaction_timeout',
      'state_invalid_transition',
      'state_machine_error',
      'sandbox_unavailable',
      'sandbox_denied',
      'session_not_found',
      'budget_exceeded',
      'unknown',
    ];

    it.each(allCodes)('should construct with code %s', (code) => {
      const error = new KCError(code, `error: ${code}`);
      expect(error.code).toBe(code);
      expect(error.message).toBe(`error: ${code}`);
      expect(error instanceof Error).toBe(true);
    });
  });

  describe('fromApiError', () => {
    it('should map HTTP 429 to api_rate_limit', () => {
      const apiError = new ApiError('Rate limited', 429);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_rate_limit');
      expect(kcError.message).toBe('Rate limited');
      expect(kcError.context).toEqual({ statusCode: 429 });
    });

    it('should map HTTP 401 to api_auth_failed', () => {
      const apiError = new ApiError('Unauthorized', 401);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_auth_failed');
    });

    it('should map HTTP 403 to api_auth_failed', () => {
      const apiError = new ApiError('Forbidden', 403);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_auth_failed');
    });

    it('should map HTTP 400 to api_bad_request', () => {
      const apiError = new ApiError('Bad request', 400);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_bad_request');
    });

    it('should map HTTP 404 to api_bad_request', () => {
      const apiError = new ApiError('Not found', 404);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_bad_request');
    });

    it('should map HTTP 422 to api_bad_request', () => {
      const apiError = new ApiError('Unprocessable', 422);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_bad_request');
    });

    it('should map HTTP 500 to api_server_error', () => {
      const apiError = new ApiError('Internal server error', 500);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_server_error');
    });

    it('should map HTTP 502 to api_server_error', () => {
      const apiError = new ApiError('Bad gateway', 502);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_server_error');
    });

    it('should map HTTP 503 to api_server_error', () => {
      const apiError = new ApiError('Service unavailable', 503);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_server_error');
    });

    it('should fall back to message-based classification for ApiError without statusCode', () => {
      const apiError = new ApiError('429 rate limit exceeded');
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_rate_limit');
    });

    it('should classify timeout messages as api_timeout', () => {
      const apiError = new ApiError('Request timeout');
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_timeout');
    });

    it('should classify auth messages as api_auth_failed', () => {
      const apiError = new ApiError('unauthorized access');
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_auth_failed');
    });

    it('should classify server error messages as api_server_error', () => {
      const apiError = new ApiError('500 internal server error');
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('api_server_error');
    });

    it('should classify unknown messages as unknown', () => {
      const apiError = new ApiError('something weird');
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.code).toBe('unknown');
    });

    it('should preserve the original error as cause', () => {
      const apiError = new ApiError('Rate limited', 429);
      const kcError = KCError.fromApiError(apiError);
      expect(kcError.cause).toBe(apiError);
    });
  });
});

describe('existing error utilities', () => {
  it('isExecError should work with standard errors', () => {
    expect(isExecError(new Error('test'))).toBe(false);
  });

  it('getErrorMessage should extract message from Error', () => {
    expect(getErrorMessage(new Error('hello'))).toBe('hello');
  });

  it('getErrorMessage should handle strings', () => {
    expect(getErrorMessage('raw string')).toBe('raw string');
  });

  it('getErrorMessage should handle unknown types', () => {
    expect(getErrorMessage(42)).toBe('42');
  });

  it('getErrorStack should return stack for Error', () => {
    const stack = getErrorStack(new Error('test'));
    expect(stack).toBeDefined();
  });

  it('getErrorStack should return undefined for non-Error', () => {
    expect(getErrorStack('not an error')).toBeUndefined();
  });
});
