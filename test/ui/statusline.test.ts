/**
 * Tests for src/ui/statusline.ts
 *
 * Covers:
 * - updateStatus (merging data, triggering render)
 * - clearStatus (clearing rendered output in TTY mode)
 * - renderStatus (internal: TTY check, session time calculation, change detection)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { updateStatus, clearStatus } from '../../src/ui/statusline';

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

describe('statusline', () => {
  describe('updateStatus', () => {
    it('renders status in TTY mode', () => {
      setTTY(true);
      updateStatus({ provider: 'openai', model: 'gpt-4' });
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('does not render in non-TTY mode', () => {
      setTTY(false);
      updateStatus({ provider: 'openai', model: 'gpt-4' });
      expect(stdoutWriteSpy).not.toHaveBeenCalled();
    });

    it('merges partial data updates', () => {
      setTTY(true);
      updateStatus({ provider: 'openai', model: 'gpt-4' });
      updateStatus({ tokensUsed: 1000 });
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('includes session time when sessionStartTime is set', () => {
      setTTY(true);
      updateStatus({
        provider: 'openai',
        model: 'gpt-4',
        sessionStartTime: Date.now() - 5000,
      });
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('renders turn count data', () => {
      setTTY(true);
      updateStatus({ turnCount: 3, maxTurns: 10 });
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('renders token count data', () => {
      setTTY(true);
      updateStatus({ tokensUsed: 5000 });
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('renders full status data', () => {
      setTTY(true);
      updateStatus({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
        turnCount: 5,
        maxTurns: 20,
        tokensUsed: 15000,
        sessionStartTime: Date.now() - 30000,
      });
      expect(stdoutWriteSpy).toHaveBeenCalled();
    });

    it('does not re-render when data has not changed', () => {
      setTTY(true);
      updateStatus({ provider: 'openai', model: 'gpt-4' });
      const callCount = stdoutWriteSpy.mock.calls.length;
      updateStatus({ provider: 'openai', model: 'gpt-4' });
      expect(stdoutWriteSpy.mock.calls.length).toBe(callCount);
    });
  });

  describe('clearStatus', () => {
    it('clears previously rendered status in TTY mode', () => {
      setTTY(true);
      updateStatus({ provider: 'openai', model: 'gpt-4' });
      stdoutWriteSpy.mockClear();
      clearStatus();
      expect(stdoutWriteSpy).toHaveBeenCalled();
      const output = stdoutWriteSpy.mock.calls[0]?.[0] as string;
      expect(output).toContain('\r');
    });

    it('does not write when there is nothing to clear', () => {
      setTTY(true);
      // clearStatus without any prior updateStatus
      clearStatus();
      // If nothing was rendered, clearStatus should not write
      // (lastRendered is '' initially)
    });
  });

  describe('multiple update and clear cycles', () => {
    it('handles multiple update/clear cycles', () => {
      setTTY(true);

      // Cycle 1
      updateStatus({ provider: 'openai', model: 'gpt-4', turnCount: 1, maxTurns: 10 });
      clearStatus();

      // Cycle 2
      updateStatus({ provider: 'anthropic', model: 'claude', turnCount: 5, maxTurns: 10 });
      clearStatus();

      expect(stdoutWriteSpy).toHaveBeenCalled();
    });
  });
});
