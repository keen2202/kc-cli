import { describe, it, expect, beforeEach } from 'vitest';
import { FileContentCache } from './FileContentCache';

describe('FileContentCache', () => {
  let cache: FileContentCache;

  beforeEach(() => {
    cache = new FileContentCache(10);
  });

  it('returns fresh on first read', () => {
    cache.setTurn(1);
    expect(cache.check('/foo.ts', 'content A')).toBe('fresh');
  });

  it('returns cachedSince on duplicate read', () => {
    cache.setTurn(1);
    cache.check('/foo.ts', 'content A');
    cache.setTurn(5);
    const result = cache.check('/foo.ts', 'content A');
    expect(result).toEqual({ cachedSince: 1 });
  });

  it('returns fresh when content changes', () => {
    cache.setTurn(1);
    cache.check('/foo.ts', 'content A');
    cache.setTurn(5);
    expect(cache.check('/foo.ts', 'content B')).toBe('fresh');
  });

  it('invalidate removes entry', () => {
    cache.setTurn(1);
    cache.check('/foo.ts', 'content A');
    cache.invalidate('/foo.ts');
    cache.setTurn(3);
    expect(cache.check('/foo.ts', 'content A')).toBe('fresh');
  });

  it('invalidateAll clears all entries', () => {
    cache.setTurn(1);
    cache.check('/a.ts', 'a');
    cache.check('/b.ts', 'b');
    cache.invalidateAll();
    expect(cache.size).toBe(0);
  });

  it('evicts oldest entry when max size reached', () => {
    const small = new FileContentCache(3);
    small.setTurn(1);
    small.check('/a.ts', 'a');
    small.check('/b.ts', 'b');
    small.check('/c.ts', 'c');
    small.check('/d.ts', 'd'); // should evict /a.ts
    expect(small.size).toBe(3);
    small.setTurn(2);
    expect(small.check('/a.ts', 'a')).toBe('fresh'); // was evicted
  });
});
