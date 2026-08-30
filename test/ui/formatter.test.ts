/**
 * Tests for src/ui/formatter.ts
 *
 * Covers:
 * - setBareMode / isBareMode
 * - formatTextDelta
 * - formatToolCall (bare + normal, truncation)
 * - formatToolResult (bare + normal, error/non-error, truncation)
 * - formatDiff (bare + normal, line limiting)
 * - formatSeparator (bare + normal)
 * - formatBanner (bare + normal)
 * - formatStatusLine (provider/model, turns, tokens, duration, combinations)
 * - formatCodeBlock (bare mode, highlight.js fallback)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  setBareMode,
  isBareMode,
  formatTextDelta,
  formatToolCall,
  formatToolResult,
  formatDiff,
  formatSeparator,
  formatBanner,
  formatStatusLine,
  formatCodeBlock,
} from '../../src/ui/formatter';

// Helper to strip ANSI escape codes for cleaner assertions
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('formatter', () => {
  afterEach(() => {
    // Reset to non-bare mode after each test
    setBareMode(false);
  });

  // ── setBareMode / isBareMode ──

  describe('setBareMode / isBareMode', () => {
    it('setBareMode toggles bare mode on', () => {
      setBareMode(true);
      expect(isBareMode()).toBe(true);
    });

    it('setBareMode toggles bare mode off', () => {
      setBareMode(true);
      setBareMode(false);
      expect(isBareMode()).toBe(false);
    });
  });

  // ── formatTextDelta ──

  describe('formatTextDelta', () => {
    it('returns the input text unchanged', () => {
      setBareMode(false);
      expect(formatTextDelta('hello world')).toBe('hello world');
    });

    it('returns the input text unchanged in bare mode', () => {
      setBareMode(true);
      expect(formatTextDelta('hello world')).toBe('hello world');
    });
  });

  // ── formatToolCall ──

  describe('formatToolCall', () => {
    it('returns bare format when bare mode is on', () => {
      setBareMode(true);
      const result = formatToolCall('search', { query: 'test' });
      expect(result).toBe('[Tool: search] {"query":"test"}');
    });

    it('returns formatted tool call in normal mode', () => {
      setBareMode(false);
      const result = formatToolCall('search', { query: 'test' });
      expect(result).toContain('Tool: search');
      expect(result).toContain('"query": "test"');
      expect(result).toContain('\n');
    });

    it('truncates long input in normal mode (>500 chars)', () => {
      setBareMode(false);
      const longInput = { data: 'x'.repeat(600) };
      const result = formatToolCall('tool', longInput);
      expect(result).toContain('...');
    });

    it('does not truncate short input in normal mode', () => {
      setBareMode(false);
      const result = formatToolCall('tool', { a: 1 });
      expect(result).not.toContain('...');
    });
  });

  // ── formatToolResult ──

  describe('formatToolResult', () => {
    it('returns bare result format when bare mode is on', () => {
      setBareMode(true);
      expect(formatToolResult('output text')).toBe('[Result] output text');
    });

    it('returns bare error format when bare mode is on and isError', () => {
      setBareMode(true);
      expect(formatToolResult('fail', true)).toBe('[Error] fail');
    });

    it('returns formatted result in normal mode', () => {
      setBareMode(false);
      const result = formatToolResult('some output');
      expect(result).toContain('Done');
      expect(result).toContain('some output');
    });

    it('returns formatted error in normal mode', () => {
      setBareMode(false);
      const result = formatToolResult('bad things happened', true);
      expect(result).toContain('Error:');
      expect(result).toContain('bad things happened');
    });

    it('truncates long output in normal mode (>300 chars)', () => {
      setBareMode(false);
      const longOutput = 'a'.repeat(400);
      const result = formatToolResult(longOutput);
      expect(result).toContain('...');
    });

    it('does not truncate short output', () => {
      setBareMode(false);
      const result = formatToolResult('short');
      expect(result).not.toContain('...');
    });
  });

  // ── formatDiff ──

  describe('formatDiff', () => {
    it('returns bare diff format when bare mode is on', () => {
      setBareMode(true);
      const result = formatDiff('file.ts', 'old', 'new');
      expect(result).toBe('[Diff: file.ts]');
    });

    it('shows changed lines in normal mode', () => {
      setBareMode(false);
      const result = formatDiff('file.ts', 'line1\nline2', 'line1\nchanged');
      const plain = stripAnsi(result);
      expect(plain).toContain('--- file.ts');
      expect(plain).toContain('- line2');
      expect(plain).toContain('+ changed');
    });

    it('shows added lines (new content longer)', () => {
      setBareMode(false);
      const result = formatDiff('a.ts', 'one', 'one\ntwo');
      const plain = stripAnsi(result);
      expect(plain).toContain('+ two');
    });

    it('shows removed lines (old content longer)', () => {
      setBareMode(false);
      const result = formatDiff('a.ts', 'one\ntwo', 'one');
      const plain = stripAnsi(result);
      expect(plain).toContain('- two');
    });

    it('limits displayed lines to maxLines (30)', () => {
      setBareMode(false);
      const oldContent = Array.from({ length: 50 }, (_, i) => `old${i}`).join('\n');
      const newContent = Array.from({ length: 50 }, (_, i) => `new${i}`).join('\n');
      const result = formatDiff('big.ts', oldContent, newContent);
      const plain = stripAnsi(result);
      expect(plain).toContain('more lines');
    });

    it('does not show "more lines" when under the limit', () => {
      setBareMode(false);
      const oldContent = Array.from({ length: 5 }, (_, i) => `old${i}`).join('\n');
      const newContent = Array.from({ length: 5 }, (_, i) => `new${i}`).join('\n');
      const result = formatDiff('small.ts', oldContent, newContent);
      const plain = stripAnsi(result);
      expect(plain).not.toContain('more lines');
    });

    it('handles identical content (no diff lines)', () => {
      setBareMode(false);
      const result = formatDiff('same.ts', 'line1\nline2', 'line1\nline2');
      const plain = stripAnsi(result);
      expect(plain).toContain('--- same.ts');
      // No +/- lines for identical content
      expect(plain).not.toContain('- line');
      expect(plain).not.toContain('+ line');
    });
  });

  // ── formatSeparator ──

  describe('formatSeparator', () => {
    it('returns "---" in bare mode', () => {
      setBareMode(true);
      expect(formatSeparator()).toBe('---');
    });

    it('returns a long separator in normal mode', () => {
      setBareMode(false);
      const result = formatSeparator();
      const plain = stripAnsi(result);
      expect(plain).toContain('─');
      expect(plain.length).toBe(80);
    });
  });

  // ── formatBanner ──

  describe('formatBanner', () => {
    it('returns bare banner in bare mode', () => {
      setBareMode(true);
      expect(formatBanner('1.0.0')).toBe('KC-CLI v1.0.0');
    });

    it('returns formatted banner in normal mode', () => {
      setBareMode(false);
      const result = formatBanner('2.5.0');
      expect(result).toContain('KC-CLI');
      expect(result).toContain('v2.5.0');
      expect(result).toContain('Intelligent Agent System');
      expect(result).toContain('\n');
    });
  });

  // ── formatStatusLine ──

  describe('formatStatusLine', () => {
    it('returns empty string in bare mode', () => {
      setBareMode(true);
      expect(formatStatusLine({ provider: 'openai', model: 'gpt-4' })).toBe('');
    });

    it('returns empty string for empty object in bare mode', () => {
      setBareMode(true);
      expect(formatStatusLine({})).toBe('');
    });

    it('renders provider and model', () => {
      setBareMode(false);
      const result = formatStatusLine({
        provider: 'anthropic',
        model: 'claude-sonnet-4-20250514',
      });
      expect(result).toContain('anthropic/claude-sonnet-4-20250514');
    });

    it('renders turn count with progress bar', () => {
      setBareMode(false);
      const result = formatStatusLine({ turnCount: 5, maxTurns: 10 });
      const plain = stripAnsi(result);
      expect(plain).toContain('5/10 turns');
      expect(result).toContain('█'); // filled block
      expect(result).toContain('░'); // empty block
    });

    it('renders token count under 1000', () => {
      setBareMode(false);
      const result = formatStatusLine({ tokensUsed: 500 });
      expect(result).toContain('500 tokens');
    });

    it('renders token count in thousands', () => {
      setBareMode(false);
      const result = formatStatusLine({ tokensUsed: 1500 });
      expect(result).toContain('1.5k tokens');
    });

    it('renders token count in millions', () => {
      setBareMode(false);
      const result = formatStatusLine({ tokensUsed: 2_500_000 });
      expect(result).toContain('2.5M tokens');
    });

    it('renders session time in seconds', () => {
      setBareMode(false);
      const result = formatStatusLine({ sessionTime: 45000 });
      const plain = stripAnsi(result);
      expect(plain).toContain('45s');
    });

    it('renders session time in minutes and seconds', () => {
      setBareMode(false);
      const result = formatStatusLine({ sessionTime: 125000 });
      const plain = stripAnsi(result);
      expect(plain).toContain('2m05s');
    });

    it('renders combined data with separators', () => {
      setBareMode(false);
      const result = formatStatusLine({
        provider: 'openai',
        model: 'gpt-4',
        turnCount: 3,
        maxTurns: 10,
        tokensUsed: 5000,
        sessionTime: 60000,
      });
      const plain = stripAnsi(result);
      expect(plain).toContain('openai/gpt-4');
      expect(plain).toContain('3/10 turns');
      expect(plain).toContain('5.0k tokens');
      expect(plain).toContain('1m00s');
      expect(result).toContain('|');
    });

    it('handles provider without model (no provider/model section)', () => {
      setBareMode(false);
      const result = formatStatusLine({ provider: 'openai' });
      expect(result).not.toContain('openai/');
    });

    it('handles model without provider (no provider/model section)', () => {
      setBareMode(false);
      const result = formatStatusLine({ model: 'gpt-4' });
      expect(result).not.toContain('/gpt-4');
    });

    it('renders turn 0% progress bar', () => {
      setBareMode(false);
      const result = formatStatusLine({ turnCount: 0, maxTurns: 10 });
      const plain = stripAnsi(result);
      expect(plain).toContain('0/10 turns');
    });

    it('renders 100% progress bar', () => {
      setBareMode(false);
      const result = formatStatusLine({ turnCount: 10, maxTurns: 10 });
      const plain = stripAnsi(result);
      expect(plain).toContain('10/10 turns');
    });

    it('handles 0 session time', () => {
      setBareMode(false);
      const result = formatStatusLine({ sessionTime: 0 });
      const plain = stripAnsi(result);
      expect(plain).toContain('0s');
    });

    it('handles exactly 1 minute', () => {
      setBareMode(false);
      const result = formatStatusLine({ sessionTime: 60000 });
      const plain = stripAnsi(result);
      expect(plain).toContain('1m00s');
    });

    it('handles tokensUsed of 0', () => {
      setBareMode(false);
      const result = formatStatusLine({ tokensUsed: 0 });
      expect(result).toContain('0 tokens');
    });

    it('handles tokensUsed of exactly 1000', () => {
      setBareMode(false);
      const result = formatStatusLine({ tokensUsed: 1000 });
      expect(result).toContain('1.0k tokens');
    });

    it('handles tokensUsed of exactly 1000000', () => {
      setBareMode(false);
      const result = formatStatusLine({ tokensUsed: 1_000_000 });
      expect(result).toContain('1.0M tokens');
    });
  });

  // ── formatCodeBlock ──

  describe('formatCodeBlock', () => {
    it('returns code as-is in bare mode', () => {
      setBareMode(true);
      const code = 'const x = 1;';
      expect(formatCodeBlock(code, 'typescript')).toBe(code);
    });

    it('returns code as-is in bare mode without language', () => {
      setBareMode(true);
      const code = 'hello';
      expect(formatCodeBlock(code)).toBe(code);
    });

    it('returns a string in normal mode (highlight.js may or may not be available)', () => {
      setBareMode(false);
      const result = formatCodeBlock('const x = 1;', 'typescript');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles auto-detection when no language is specified', () => {
      setBareMode(false);
      const result = formatCodeBlock('function foo() { return 1; }');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
