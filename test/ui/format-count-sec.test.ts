// T29 (M4): explicit unit contracts for the shared formatters — round4 §6-M4

import { describe, it, expect } from 'vitest';
import { formatDuration, formatDurationSec, formatCount } from '../../src/ui/format-duration';

describe('T29: formatDurationSec (seconds contract)', () => {
  it('renders compact seconds/minutes like the status bar contract', () => {
    expect(formatDurationSec(12)).toBe('12s');
    expect(formatDurationSec(125)).toBe('2m05s');
    expect(formatDurationSec(0)).toBe('0s');
  });

  it('guards non-finite and negative inputs', () => {
    expect(formatDurationSec(NaN)).toBe('0s');
    expect(formatDurationSec(-3)).toBe('0s');
  });
});

describe('T29: formatCount (token count with M tier)', () => {
  it('abbreviates k and M tiers', () => {
    expect(formatCount(999)).toBe('999');
    expect(formatCount(12_300)).toBe('12.3k');
    expect(formatCount(1_200_000)).toBe('1.2M');
  });

  it('gives SessionInfo the M tier it previously lacked', () => {
    // SessionInfo rendered 1_200_000 as the raw number before consolidation.
    expect(formatCount(1_500_000)).toBe('1.5M');
  });
});

describe('T29: formatDuration (ms contract) unchanged', () => {
  it('keeps the clock style for session displays', () => {
    expect(formatDuration(187_000)).toBe('3:07');
    expect(formatDuration(3_600_000)).toBe('1:00:00');
  });
});
