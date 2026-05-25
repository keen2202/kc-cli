// Tests for unified error handling utilities

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  withToolErrorHandling,
  formatToolError,
  withSyncErrorHandling,
  createErrorResult,
  isTimeoutError,
  isNetworkError,
  isPermissionError,
  getErrorCode,
} from './errorHandling';
import { ExecError } from '../types/errors';

describe('withToolErrorHandling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns operation result on success', async () => {
    const result = await withToolErrorHandling('TestTool', async () => {
      return 'success';
    });
    expect(result).toBe('success');
  });

  it('returns fallback on error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await withToolErrorHandling(
      'TestTool',
      async () => {
        throw new Error('Test error');
      },
      { fallback: 'fallback' }
    );

    expect(result).toBe('fallback');
    expect(consoleSpy).toHaveBeenCalled();
  });

  it('rethrows error when rethrow is true', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      withToolErrorHandling(
        'TestTool',
        async () => {
          throw new Error('Test error');
        },
        { rethrow: true }
      )
    ).rejects.toThrow('Test error');
  });

  it('logs error by default', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await withToolErrorHandling('TestTool', async () => {
        throw new Error('Test error');
      });
    } catch {
      // Expected
    }

    expect(consoleSpy).toHaveBeenCalled();
    const firstCall = consoleSpy.mock.calls[0];
    expect(firstCall[0]).toContain('[TestTool] Tool execution failed: Test error');
  });

  it('does not log error when logError is false', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await withToolErrorHandling(
        'TestTool',
        async () => {
          throw new Error('Test error');
        },
        { logError: false }
      );
    } catch {
      // Expected
    }

    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('uses custom message prefix', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await withToolErrorHandling(
        'TestTool',
        async () => {
          throw new Error('Test error');
        },
        { messagePrefix: 'Custom prefix' }
      );
    } catch {
      // Expected
    }

    expect(consoleSpy).toHaveBeenCalled();
    const firstCall = consoleSpy.mock.calls[0];
    expect(firstCall[0]).toContain('Custom prefix: Test error');
  });
});

describe('formatToolError', () => {
  it('formats Error instance', () => {
    const error = new Error('Test error');
    const result = formatToolError('TestTool', error);

    expect(result.output).toBe('TestTool failed: Test error');
    expect(result.isError).toBe(true);
    expect(result.metadata.tool).toBe('TestTool');
    expect(result.metadata.errorType).toBe('Error');
  });

  it('formats string error', () => {
    const result = formatToolError('TestTool', 'String error');

    expect(result.output).toBe('TestTool failed: String error');
    expect(result.metadata.errorType).toBe('string');
  });

  it('formats ExecError with metadata', () => {
    const error = new Error('Command failed') as ExecError;
    error.code = 1;
    error.signal = 'SIGTERM';
    error.stderr = 'stderr output';

    const result = formatToolError('TestTool', error);

    expect(result.metadata.exitCode).toBe(1);
    expect(result.metadata.signal).toBe('SIGTERM');
    expect(result.metadata.stderr).toBe('stderr output');
    expect(result.output).toContain('stderr output');
  });

  it('includes additional context', () => {
    const error = new Error('Test error');
    const result = formatToolError('TestTool', error, { customKey: 'value' });

    expect(result.metadata.customKey).toBe('value');
  });
});

describe('withSyncErrorHandling', () => {
  it('returns operation result on success', () => {
    const result = withSyncErrorHandling('TestTool', () => 'success', 'fallback');
    expect(result).toBe('success');
  });

  it('returns fallback on error', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = withSyncErrorHandling(
      'TestTool',
      () => {
        throw new Error('Test error');
      },
      'fallback'
    );

    expect(result).toBe('fallback');
  });
});

describe('createErrorResult', () => {
  it('creates error result with toolCallId', () => {
    const result = createErrorResult('call-1', 'Error message');

    expect(result.toolCallId).toBe('call-1');
    expect(result.output).toBe('Error message');
    expect(result.isError).toBe(true);
  });

  it('includes metadata', () => {
    const result = createErrorResult('call-1', 'Error message', { key: 'value' });

    expect(result.metadata).toEqual({ key: 'value' });
  });
});

describe('error type detection', () => {
  it('detects timeout errors', () => {
    expect(isTimeoutError(new Error('Operation timed out'))).toBe(true);
    expect(isTimeoutError(new Error('Request timeout'))).toBe(true);
    expect(isTimeoutError(new Error('Other error'))).toBe(false);
  });

  it('detects network errors', () => {
    expect(isNetworkError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isNetworkError(new Error('Network error'))).toBe(true);
    expect(isNetworkError(new Error('ENOTFOUND'))).toBe(true);
    expect(isNetworkError(new Error('Other error'))).toBe(false);
  });

  it('detects permission errors', () => {
    expect(isPermissionError(new Error('Permission denied'))).toBe(true);
    expect(isPermissionError(new Error('EACCES'))).toBe(true);
    expect(isPermissionError(new Error('Other error'))).toBe(false);
  });

  it('returns correct error codes', () => {
    expect(getErrorCode(new Error('timeout'))).toBe('TIMEOUT');
    expect(getErrorCode(new Error('econnrefused'))).toBe('NETWORK');
    expect(getErrorCode(new Error('permission denied'))).toBe('PERMISSION');
    expect(getErrorCode(new Error('other'))).toBe('UNKNOWN');
  });
});
