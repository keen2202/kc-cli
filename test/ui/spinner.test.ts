/**
 * Tests for src/ui/spinner.ts
 *
 * Covers:
 * - Spinner.start (TTY + non-TTY)
 * - Spinner.stop (TTY + non-TTY, with/without finalText)
 * - Spinner.fail (with/without errorText)
 * - Interval lifecycle (start creates interval, stop/fail clears it)
 * - Frame cycling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Spinner } from '../../src/ui/spinner';

let stdoutWriteSpy: ReturnType<typeof vi.spyOn>;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  originalIsTTY = process.stdout.isTTY;
});

afterEach(() => {
  stdoutWriteSpy.mockRestore();
  Object.defineProperty(process.stdout, 'isTTY', {
    value: originalIsTTY,
    writable: true,
    configurable: true,
  });
});

function setTTY(val: boolean) {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: val,
    writable: true,
    configurable: true,
  });
}

describe('Spinner', () => {
  describe('start', () => {
    it('writes text immediately in non-TTY mode', () => {
      setTTY(false);
      const spinner = new Spinner();
      spinner.start('Loading');
      expect(stdoutWriteSpy).toHaveBeenCalledWith('Loading...');
    });

    it('does not throw in TTY mode', () => {
      setTTY(true);
      const spinner = new Spinner();
      expect(() => spinner.start('Working')).not.toThrow();
    });

    it('sets up an interval in TTY mode', () => {
      setTTY(true);
      const spinner = new Spinner();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      spinner.start('Processing');
      expect(setIntervalSpy).toHaveBeenCalled();
      setIntervalSpy.mockRestore();
    });
  });

  describe('stop', () => {
    it('writes finalText in non-TTY mode', () => {
      setTTY(false);
      const spinner = new Spinner();
      spinner.start('Loading');
      stdoutWriteSpy.mockClear();
      spinner.stop('done');
      expect(stdoutWriteSpy).toHaveBeenCalledWith(' done\n');
    });

    it('does not write in non-TTY mode when no finalText', () => {
      setTTY(false);
      const spinner = new Spinner();
      spinner.start('Loading');
      stdoutWriteSpy.mockClear();
      spinner.stop();
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('writes completion output in TTY mode', () => {
      setTTY(true);
      const spinner = new Spinner();
      spinner.start('Working');
      stdoutWriteSpy.mockClear();
      spinner.stop('finished');
      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('finished');
    });

    it('uses original text when no finalText given in TTY mode', () => {
      setTTY(true);
      const spinner = new Spinner();
      spinner.start('Original task');
      stdoutWriteSpy.mockClear();
      spinner.stop();
      const output = stdoutWriteSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('Original task');
    });

    it('clears the interval', () => {
      setTTY(true);
      const spinner = new Spinner();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      spinner.start('Task');
      spinner.stop();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('does not throw when stop is called without start', () => {
      setTTY(false);
      const spinner = new Spinner();
      expect(() => spinner.stop('done')).not.toThrow();
    });
  });

  describe('fail', () => {
    it('writes error output in TTY mode', () => {
      setTTY(true);
      const spinner = new Spinner();
      spinner.start('Task');
      stdoutWriteSpy.mockClear();
      spinner.fail('something broke');
      const output = stdoutWriteSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('something broke');
    });

    it('uses original text when no errorText given', () => {
      setTTY(true);
      const spinner = new Spinner();
      spinner.start('My task');
      stdoutWriteSpy.mockClear();
      spinner.fail();
      const output = stdoutWriteSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('My task');
    });

    it('clears the interval', () => {
      setTTY(true);
      const spinner = new Spinner();
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      spinner.start('Task');
      spinner.fail('error');
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('does not throw when fail is called without start', () => {
      setTTY(true);
      const spinner = new Spinner();
      expect(() => spinner.fail('err')).not.toThrow();
    });
  });

  describe('interval animation (TTY)', () => {
    it('writes frames on each interval tick', () => {
      vi.useFakeTimers();
      try {
        setTTY(true);
        const spinner = new Spinner();
        spinner.start('Animating');

        // Advance timer to trigger a few interval callbacks
        vi.advanceTimersByTime(240); // 3 ticks at 80ms

        // Should have written multiple times (at least 3 interval calls)
        expect(stdoutWriteSpy.mock.calls.length).toBeGreaterThanOrEqual(3);

        // Each write should contain \r (carriage return for overwriting)
        for (const call of stdoutWriteSpy.mock.calls) {
          expect(call[0]).toContain('\r');
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('cycles through frame characters', () => {
      vi.useFakeTimers();
      try {
        setTTY(true);
        const spinner = new Spinner();
        spinner.start('Test');

        // Advance enough to cycle through frames
        vi.advanceTimersByTime(800); // 10 ticks

        const outputs = stdoutWriteSpy.mock.calls.map(
          (c) => (c[0] as string).split(' ')[0].replace('\r', ''),
        );
        const unique = new Set(outputs);
        expect(unique.size).toBeGreaterThan(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('full lifecycle', () => {
    it('start -> stop works in TTY mode', () => {
      setTTY(true);
      const spinner = new Spinner();
      spinner.start('Step 1');
      spinner.stop('Done');
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('start -> fail works in TTY mode', () => {
      setTTY(true);
      const spinner = new Spinner();
      spinner.start('Step 1');
      spinner.fail('Oops');
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('start -> stop works in non-TTY mode', () => {
      setTTY(false);
      const spinner = new Spinner();
      spinner.start('Loading');
      spinner.stop('complete');
      expect(stdoutWriteSpy).toHaveBeenCalledTimes(2);
    });
  });
});
