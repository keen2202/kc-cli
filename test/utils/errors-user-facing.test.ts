// User-facing error formatting: stable code + actionable suggestion

import { describe, it, expect } from 'vitest';
import {
  KCError,
  classifyErrorCode,
  formatUserFacingError,
  getErrorSuggestion,
  ERROR_CODE_SUGGESTIONS,
} from '../../src/utils/errors.js';

describe('classifyErrorCode', () => {
  it('keeps the code of a KCError', () => {
    expect(classifyErrorCode(new KCError('budget_exceeded', 'over'))).toBe('budget_exceeded');
    expect(classifyErrorCode(new KCError('sandbox_unavailable', 'none'))).toBe('sandbox_unavailable');
  });

  it('classifies common network/timeout/auth signatures', () => {
    expect(classifyErrorCode(new Error('Request timed out'))).toBe('api_timeout');
    expect(classifyErrorCode(new Error('fetch failed ECONNREFUSED'))).toBe('api_server_error');
    expect(classifyErrorCode(new Error('429 rate limit exceeded'))).toBe('api_rate_limit');
    expect(classifyErrorCode(new Error('Unauthorized: invalid api key'))).toBe('api_auth_failed');
    expect(classifyErrorCode(new Error('EACCES: permission denied'))).toBe('tool_permission_denied');
  });

  it('falls back to unknown', () => {
    expect(classifyErrorCode(new Error('something odd'))).toBe('unknown');
    expect(classifyErrorCode('plain string')).toBe('unknown');
  });
});

describe('formatUserFacingError', () => {
  it('renders [code] message — Suggestion: …', () => {
    const out = formatUserFacingError(new Error('Request timed out'));
    expect(out).toContain('[api_timeout]');
    expect(out).toContain('Request timed out');
    expect(out).toContain('Suggestion:');
    expect(out).toContain(getErrorSuggestion('api_timeout'));
  });

  it('uses the KCError code directly', () => {
    const out = formatUserFacingError(new KCError('tool_timeout', 'Tool Bash timed out'));
    expect(out).toContain('[tool_timeout]');
    expect(out).toContain(ERROR_CODE_SUGGESTIONS.tool_timeout);
  });

  it('has a suggestion for every error code', () => {
    for (const [code, suggestion] of Object.entries(ERROR_CODE_SUGGESTIONS)) {
      expect(suggestion.length, `suggestion for ${code}`).toBeGreaterThan(10);
    }
  });
});
