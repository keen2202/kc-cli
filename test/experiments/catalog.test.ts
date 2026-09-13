import { describe, it, expect } from 'vitest';
import {
  parseCatalog,
  computeBaseHash,
  computeBaseHashJson,
  getActivePromotedVariant,
  EMPTY_CATALOG,
  CATALOG_FORMAT,
} from '../../src/experiments/catalog';

describe('experiments/catalog', () => {
  it('returns empty catalog on invalid JSON', () => {
    expect(parseCatalog('not-json').artifacts).toEqual({});
  });

  it('returns empty catalog on wrong format', () => {
    const catalog = parseCatalog(JSON.stringify({ format: 'other', artifacts: {} }));
    expect(catalog.artifacts).toEqual({});
  });

  it('parses a valid catalog', () => {
    const raw = JSON.stringify({
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:failure-recovery': {
          kind: 'prompt-surface',
          baseHash: computeBaseHash('BASE'),
          active: 'c1',
          variants: [
            {
              variantId: 'c1',
              status: 'promoted',
              payload: 'NEW',
              evidenceRef: 'sha256:abc',
            },
          ],
        },
      },
    });
    const catalog = parseCatalog(raw);
    const variant = getActivePromotedVariant(catalog, 'prompt-surface:failure-recovery');
    expect(variant?.payload).toBe('NEW');
  });

  it('ignores non-promoted active variants', () => {
    const raw = JSON.stringify({
      format: CATALOG_FORMAT,
      artifacts: {
        'prompt-surface:x': {
          kind: 'prompt-surface',
          baseHash: 'sha256:0',
          active: 'c1',
          variants: [{ variantId: 'c1', status: 'candidate', payload: 'X', evidenceRef: 'e' }],
        },
      },
    });
    expect(getActivePromotedVariant(parseCatalog(raw), 'prompt-surface:x')).toBeNull();
  });

  it('baseHash is stable for same text and different for different text', () => {
    expect(computeBaseHash('abc')).toBe(computeBaseHash('abc'));
    expect(computeBaseHash('abc')).not.toBe(computeBaseHash('abd'));
    expect(computeBaseHashJson({ a: 1, b: 2 })).toBe(computeBaseHashJson({ b: 2, a: 1 }));
  });

  it('EMPTY_CATALOG has zero artifacts', () => {
    expect(EMPTY_CATALOG.artifacts).toEqual({});
  });
});
