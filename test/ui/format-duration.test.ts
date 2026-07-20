/**
 * Tests for the shared session-duration formatter.
 */

import { describe, it, expect } from 'vitest';
import { formatDuration } from '../../src/ui/format-duration';

describe('formatDuration', () => {
  it('formats sub-hour durations as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(7_000)).toBe('0:07');
    expect(formatDuration(67_000)).toBe('1:07');
    expect(formatDuration(187_000)).toBe('3:07');
  });

  it('rolls over into h:mm:ss at one hour', () => {
    expect(formatDuration(3_600_000)).toBe('1:00:00');
    expect(formatDuration(3_600_000 + 129_000)).toBe('1:02:09');
    expect(formatDuration(36_000_000 + 3_600_000)).toBe('11:00:00');
  });

  it('clamps non-finite and negative inputs to zero', () => {
    expect(formatDuration(-5_000)).toBe('0:00');
    expect(formatDuration(Number.NaN)).toBe('0:00');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});
