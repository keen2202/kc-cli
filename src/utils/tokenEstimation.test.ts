import { describe, it, expect } from 'vitest';
import { estimateCompactionSavings } from './tokenEstimation';

describe('estimateCompactionSavings', () => {
  it('estimates positive savings when many failed attempts exist', () => {
    const result = estimateCompactionSavings(50, 3, 20, 27);
    expect(result.savedTokens).toBeGreaterThan(0);
    expect(result.savingsPercent).toBeGreaterThan(0);
  });

  it('returns zero savings for short runs', () => {
    const result = estimateCompactionSavings(5, 2, 1, 2);
    expect(result.savedTokens).toBe(0);
  });
});
