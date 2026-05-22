/**
 * Tests for StatusBar component.
 *
 * Covers:
 * - renderStatusBar with various data combinations
 * - formatTokenCount (via renderStatusBar output)
 * - formatDuration (via renderStatusBar output)
 * - renderProgressBar (via renderStatusBar output)
 * - Empty/undefined fields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderStatusBar } from '../../src/ui/components/StatusBar';

describe('StatusBar', () => {
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalColumns = process.stdout.columns;
    // Set a fixed column width for deterministic tests
    Object.defineProperty(process.stdout, 'columns', { value: 80, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, writable: true, configurable: true });
  });

  describe('renderStatusBar', () => {
    it('returns empty string when no data provided', () => {
      const result = renderStatusBar({});
      expect(result).toBe('');
    });

    it('returns empty string when all fields are undefined', () => {
      const result = renderStatusBar({
        provider: undefined,
        model: undefined,
        turnCount: undefined,
        maxTurns: undefined,
        tokensUsed: undefined,
        sessionStartTime: undefined,
      });
      expect(result).toBe('');
    });

    it('renders provider and model', () => {
      const result = renderStatusBar({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
      });
      expect(result).toContain('anthropic/claude-sonnet-4-20250514');
      expect(result).toContain('─'); // separator line
      expect(result).toContain('│'); // border
    });

    it('renders turn count with progress bar', () => {
      const result = renderStatusBar({
        turnCount: 5,
        maxTurns: 10,
      });
      expect(result).toContain('5/10 turns');
      expect(result).toContain('█'); // filled progress
      expect(result).toContain('░'); // empty progress
    });

    it('renders token count in thousands', () => {
      const result = renderStatusBar({
        tokensUsed: 5000,
      });
      expect(result).toContain('5.0k tokens');
    });

    it('renders token count in millions', () => {
      const result = renderStatusBar({
        tokensUsed: 2_500_000,
      });
      expect(result).toContain('2.5M tokens');
    });

    it('renders small token count without suffix', () => {
      const result = renderStatusBar({
        tokensUsed: 500,
      });
      expect(result).toContain('500 tokens');
    });

    it('renders session duration in seconds', () => {
      const startTime = Date.now() - 30_000; // 30 seconds ago
      vi.useFakeTimers();
      vi.setSystemTime(Date.now());

      const result = renderStatusBar({
        sessionStartTime: startTime,
      });
      expect(result).toContain('30s');

      vi.useRealTimers();
    });

    it('renders session duration in minutes and seconds', () => {
      const startTime = Date.now() - 125_000; // 2m5s ago
      vi.useFakeTimers();
      vi.setSystemTime(Date.now());

      const result = renderStatusBar({
        sessionStartTime: startTime,
      });
      expect(result).toContain('2m5s');

      vi.useRealTimers();
    });

    it('renders all fields together', () => {
      const startTime = Date.now() - 60_000;
      vi.useFakeTimers();
      vi.setSystemTime(Date.now());

      const result = renderStatusBar({
        provider: 'openai',
        model: 'gpt-4o',
        turnCount: 3,
        maxTurns: 10,
        tokensUsed: 15000,
        sessionStartTime: startTime,
      });

      expect(result).toContain('openai/gpt-4o');
      expect(result).toContain('3/10 turns');
      expect(result).toContain('15.0k tokens');
      // 60 seconds = 1m0s in the formatDuration function
      expect(result).toContain('1m0s');
      expect(result).toContain('|'); // separator between parts

      vi.useRealTimers();
    });

    it('renders progress bar at 0%', () => {
      const result = renderStatusBar({
        turnCount: 0,
        maxTurns: 10,
      });
      expect(result).toContain('0/10 turns');
      // All empty blocks
      expect(result).toContain('░');
    });

    it('renders progress bar at 100%', () => {
      const result = renderStatusBar({
        turnCount: 10,
        maxTurns: 10,
      });
      expect(result).toContain('10/10 turns');
      // All filled blocks
      expect(result).toContain('█');
    });

    it('handles zero token count', () => {
      const result = renderStatusBar({
        tokensUsed: 0,
      });
      expect(result).toContain('0 tokens');
    });

    it('handles very large token count', () => {
      const result = renderStatusBar({
        tokensUsed: 1_000_000,
      });
      expect(result).toContain('1.0M tokens');
    });

    it('renders border lines with correct width', () => {
      const result = renderStatusBar({
        provider: 'test',
        model: 'model',
      });
      // Should contain horizontal rule
      const lines = result.split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(lines[0]).toContain('─');
    });
  });
});
