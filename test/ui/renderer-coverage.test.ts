import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createThrottle, createDebounce } from '../../src/ui/renderer';

describe('createThrottle - coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should execute immediately on first call', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled('a');
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('should not execute again within throttle window', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled('a');
    throttled('b');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('should execute trailing call after window expires', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled('a');
    throttled('b');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('should execute immediately again after window expires', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled('a');
    vi.advanceTimersByTime(100);
    throttled('b');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('should cancel pending trailing call', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled('a');
    throttled('b');
    throttled.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should do nothing on cancel when no pending call', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled.cancel(); // No-op
    expect(fn).not.toHaveBeenCalled();
  });

  it('should flush pending trailing call immediately', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled('a');
    throttled('b');
    throttled.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('should do nothing on flush when no pending call', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    throttled.flush(); // No-op
    expect(fn).not.toHaveBeenCalled();
  });

  it('should handle rapid burst of calls', () => {
    const fn = vi.fn();
    const throttled = createThrottle(fn, 100);
    for (let i = 0; i < 20; i++) {
      throttled(i);
    }
    // First call executes immediately
    expect(fn).toHaveBeenCalledTimes(1);
    // After window, trailing call executes
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(19);
  });
});

describe('createDebounce - coverage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should delay execution', () => {
    const fn = vi.fn();
    const debounced = createDebounce(fn, 100);
    debounced('a');
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('should reset delay on subsequent calls', () => {
    const fn = vi.fn();
    const debounced = createDebounce(fn, 100);
    debounced('a');
    vi.advanceTimersByTime(50);
    debounced('b');
    vi.advanceTimersByTime(50);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledWith('b');
  });

  it('should only execute last call', () => {
    const fn = vi.fn();
    const debounced = createDebounce(fn, 100);
    debounced('a');
    debounced('b');
    debounced('c');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('c');
  });

  it('should cancel pending execution', () => {
    const fn = vi.fn();
    const debounced = createDebounce(fn, 100);
    debounced('a');
    debounced.cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('should do nothing on cancel when no pending', () => {
    const fn = vi.fn();
    const debounced = createDebounce(fn, 100);
    debounced.cancel(); // No-op
    expect(fn).not.toHaveBeenCalled();
  });

  it('should flush pending execution immediately', () => {
    const fn = vi.fn();
    const debounced = createDebounce(fn, 100);
    debounced('a');
    debounced.flush();
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('should do nothing on flush when no pending', () => {
    const fn = vi.fn();
    const debounced = createDebounce(fn, 100);
    debounced.flush(); // No-op
    expect(fn).not.toHaveBeenCalled();
  });

  it('should clear timer on cancel', () => {
    const fn = vi.fn();
    const debounced = createDebounce(fn, 100);
    debounced('a');
    debounced.cancel();
    debounced('b');
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('b');
  });
});
