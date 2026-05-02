import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  startIdleDetection,
  stopIdleDetection,
  recordActivity,
  getLastActivityTime,
  isIdle,
  getTimeSinceActivity,
  setIdleThreshold,
  checkIdleState,
} from '../../src/services/idleDetection';

describe('idleDetection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopIdleDetection();
  });

  afterEach(() => {
    stopIdleDetection();
    vi.useRealTimers();
  });

  it('should record activity and get last activity time', () => {
    const before = getLastActivityTime();
    vi.advanceTimersByTime(1000);
    recordActivity();
    const after = getLastActivityTime();
    expect(after).toBeGreaterThan(before);
  });

  it('should report not idle when recently active', () => {
    recordActivity();
    expect(isIdle()).toBe(false);
  });

  it('should report idle when threshold exceeded', () => {
    setIdleThreshold(0); // 0 minutes = 0ms threshold
    recordActivity();
    vi.advanceTimersByTime(1);
    expect(isIdle()).toBe(true);
  });

  it('should get time since activity', () => {
    recordActivity();
    vi.advanceTimersByTime(5000);
    const elapsed = getTimeSinceActivity();
    expect(elapsed).toBeGreaterThanOrEqual(5000);
  });

  it('should call idle callback when threshold exceeded', () => {
    const callback = vi.fn();
    startIdleDetection(1, callback); // 1 minute
    recordActivity();
    // Advance past threshold (1 min = 60000ms)
    vi.advanceTimersByTime(60001);
    // checkIdleState is called by interval (every 30s)
    // Manually call to verify
    checkIdleState();
    expect(callback).toHaveBeenCalled();
  });

  it('should not call idle callback when within threshold', () => {
    const callback = vi.fn();
    startIdleDetection(5, callback); // 5 minutes
    recordActivity();
    vi.advanceTimersByTime(60000); // 1 minute
    checkIdleState();
    expect(callback).not.toHaveBeenCalled();
  });

  it('should stop idle detection', () => {
    const callback = vi.fn();
    startIdleDetection(1, callback);
    stopIdleDetection();
    recordActivity();
    vi.advanceTimersByTime(120000);
    // No interval should fire
    expect(callback).not.toHaveBeenCalled();
  });

  it('should update threshold on repeated start', () => {
    const callback1 = vi.fn();
    const callback2 = vi.fn();
    startIdleDetection(5, callback1);
    startIdleDetection(1, callback2); // Update
    recordActivity();
    vi.advanceTimersByTime(60001);
    checkIdleState();
    expect(callback2).toHaveBeenCalled();
  });

  it('should set idle threshold', () => {
    setIdleThreshold(10); // 10 minutes
    recordActivity();
    vi.advanceTimersByTime(600000); // 10 minutes
    expect(isIdle()).toBe(true);
  });

  it('should check idle state via interval', () => {
    const callback = vi.fn();
    startIdleDetection(0, callback); // 0 minutes = instant idle
    recordActivity();
    vi.advanceTimersByTime(30000); // Advance past one interval cycle
    expect(callback).toHaveBeenCalled();
  });
});
