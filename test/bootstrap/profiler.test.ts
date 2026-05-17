import { describe, it, expect, beforeEach } from 'vitest';

beforeEach(async () => {
  const { resetProfile } = await import('../../src/bootstrap/profiler');
  resetProfile();
});

describe('Profiler', () => {
  it('should record checkpoints', async () => {
    const { profileCheckpoint, getProfileReport } = await import('../../src/bootstrap/profiler');
    profileCheckpoint('start');
    profileCheckpoint('middle');
    profileCheckpoint('end');

    const report = getProfileReport();
    expect(report).toContain('Performance Profile');
    expect(report).toContain('start');
    expect(report).toContain('middle');
    expect(report).toContain('end');
    expect(report).toContain('Total:');
  });

  it('should return no data when no checkpoints recorded', async () => {
    const { getProfileReport } = await import('../../src/bootstrap/profiler');
    const report = getProfileReport();
    expect(report).toBe('No profile data');
  });

  it('should calculate deltas between checkpoints', async () => {
    const { profileCheckpoint, getProfileReport } = await import('../../src/bootstrap/profiler');
    profileCheckpoint('first');
    profileCheckpoint('second');

    const report = getProfileReport();
    expect(report).toContain('first');
    expect(report).toContain('second');
  });

  it('should reset all data', async () => {
    const { profileCheckpoint, getProfileReport, resetProfile } = await import('../../src/bootstrap/profiler');
    profileCheckpoint('a');
    expect(getProfileReport()).toContain('Performance Profile');
    resetProfile();
    expect(getProfileReport()).toBe('No profile data');
  });

  it('should format with millisecond precision', async () => {
    const { profileCheckpoint, getProfileReport } = await import('../../src/bootstrap/profiler');
    profileCheckpoint('init');
    const report = getProfileReport();
    expect(report).toMatch(/ms/);
  });
});
