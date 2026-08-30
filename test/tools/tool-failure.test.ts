// T30 (M5): toolFailure routes error text through getErrorMessage — round4 §6-M5

import { describe, it, expect } from 'vitest';
import { toolFailure } from '../../src/Tool';

describe('T30: toolFailure', () => {
  it('handles Error instances', () => {
    const result = toolFailure('Grep', new Error('regex blew up'));
    expect(result.isError).toBe(true);
    expect(result.message).toBe('Grep failed: regex blew up');
  });

  it('renders error-like plain objects instead of [object Object]', () => {
    // The inline `error instanceof Error ? ... : String(error)` copies that
    // this replaces degraded a deserialized { message } object to '[object Object]'.
    const result = toolFailure('TaskGet', { message: 'task 42 not found' });
    expect(result.isError).toBe(true);
    expect(result.message).toBe('TaskGet failed: task 42 not found');
  });

  it('handles plain strings and null/undefined', () => {
    expect(toolFailure('Glob', 'disk gone').message).toBe('Glob failed: disk gone');
    expect(toolFailure('Glob', null).message).toContain('Glob failed:');
    expect(toolFailure('Glob', undefined).message).toContain('Glob failed:');
  });

  it('forwards metadata into the result', () => {
    const result = toolFailure('WebFetch', new Error('boom'), { url: 'https://x' });
    expect(result.metadata).toEqual({ url: 'https://x' });
  });
});
