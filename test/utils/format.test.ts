import { describe, it, expect, vi, afterEach } from 'vitest';
import { getAgeText } from '../../src/utils/format';

describe('getAgeText', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return "just now" for recent timestamps', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000);
    expect(getAgeText(999999)).toBe('just now');
  });

  it('should return hours ago', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000 + 3 * 3600000);
    expect(getAgeText(1000000)).toBe('3h ago');
  });

  it('should return "yesterday" for 24h ago', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000 + 24 * 3600000);
    expect(getAgeText(1000000)).toBe('yesterday');
  });

  it('should return days ago', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000 + 5 * 24 * 3600000);
    expect(getAgeText(1000000)).toBe('5d ago');
  });

  it('should return months ago', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000 + 60 * 24 * 3600000);
    expect(getAgeText(1000000)).toBe('2mo ago');
  });

  it('should return years ago', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000 + 400 * 24 * 3600000);
    expect(getAgeText(1000000)).toBe('1y ago');
  });

  it('should handle edge case of exactly 1 hour', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000 + 3600000);
    expect(getAgeText(1000000)).toBe('1h ago');
  });

  it('should handle edge case of 23 hours', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000000 + 23 * 3600000);
    expect(getAgeText(1000000)).toBe('23h ago');
  });
});
