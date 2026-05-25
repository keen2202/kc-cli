// Tests for cache compression

import { describe, it, expect } from 'vitest';
import { stableHash } from './compression';



describe('stableHash', () => {
  it('should create consistent hashes', () => {
    expect(stableHash('hello')).toBe(stableHash('hello'));
    expect(stableHash('hello')).not.toBe(stableHash('world'));
  });

  it('should return 16 character hex string', () => {
    const hash = stableHash('test');
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should handle empty string', () => {
    const hash = stableHash('');
    expect(hash).toHaveLength(16);
  });
});
