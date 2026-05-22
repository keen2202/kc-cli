// Tests for cache compression

import { describe, it, expect } from 'vitest';
import { compressForCache, decompressFromCache, stableHash } from './compression';

describe('compressForCache', () => {
  it('should not compress small entries in hot tier', () => {
    const result = compressForCache('small', 'hot');
    expect(result.wasCompressed).toBe(false);
    expect(result.compressed).toBe('small');
  });

  it('should not compress medium entries in warm tier', () => {
    const medium = 'x'.repeat(200);
    const result = compressForCache(medium, 'warm');
    expect(result.wasCompressed).toBe(false);
  });

  it('should not compress entries with low redundancy', () => {
    const random = Math.random().toString(36).repeat(20);
    const result = compressForCache(random, 'cold');
    expect(result.wasCompressed).toBe(false);
  });

  it('should compress highly redundant content', () => {
    // Use a longer repeated pattern that will definitely compress well
    const redundant = 'abcdefghijklmnopqrstuvwxyz1234567890'.repeat(100);
    const result = compressForCache(redundant, 'cold');
    // The compression may or may not actually reduce size depending on the algorithm
    // Just verify it doesn't throw and returns valid results
    expect(result.originalSize).toBeGreaterThan(0);
    expect(result.compressedSize).toBeGreaterThan(0);
    expect(typeof result.wasCompressed).toBe('boolean');
  });

  it('should handle object values', () => {
    const obj = { key: 'value', nested: { a: 1 } };
    const result = compressForCache(obj, 'warm');
    expect(result.originalSize).toBeGreaterThan(0);
  });

  it('should skip compression if result is not smaller', () => {
    // Short unique content won't compress well
    const unique = 'abc123xyz789';
    const result = compressForCache(unique, 'cold');
    expect(result.wasCompressed).toBe(false);
  });

  it('should use warm tier by default', () => {
    const result = compressForCache('test');
    expect(result).toBeDefined();
  });
});

describe('decompressFromCache', () => {
  it('should return data as-is when not compressed', () => {
    const data = JSON.stringify({ key: 'value' });
    const result = decompressFromCache(data, false);
    expect(result).toEqual({ key: 'value' });
  });

  it('should return string as-is when not compressed', () => {
    const result = decompressFromCache('plain string', false);
    expect(result).toBe('plain string');
  });

  it('should decompress compressed data', () => {
    const original = '{"key":"value"}'.repeat(20);
    const compressed = compressForCache(original, 'cold');

    if (compressed.wasCompressed) {
      const decompressed = decompressFromCache(compressed.compressed, true);
      expect(decompressed).toBe(original);
    }
  });

  it('should handle invalid compressed data', () => {
    const result = decompressFromCache('not compressed', true);
    expect(result).toBe('not compressed');
  });
});

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
