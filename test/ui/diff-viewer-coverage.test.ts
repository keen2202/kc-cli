import { describe, it, expect, vi } from 'vitest';

// Mock the diff library to trigger fallback
vi.mock('diff', () => {
  throw new Error('diff library not available');
});

vi.mock('../../src/ui/formatter', () => ({
  isBareMode: vi.fn().mockReturnValue(false),
}));

import {
  computeDiff,
  renderDiffLines,
  renderMultiFileDiff,
  type FileDiff,
} from '../../src/ui/diff-viewer';
import { isBareMode } from '../../src/ui/formatter';

describe('computeDiff fallback (no diff library)', () => {
  it('should handle identical texts', () => {
    const diff = computeDiff('line1\nline2', 'line1\nline2');
    const contexts = diff.filter(d => d.type === 'context');
    expect(contexts.length).toBe(2);
  });

  it('should handle completely different texts', () => {
    const diff = computeDiff('old', 'new');
    expect(diff.length).toBe(2);
    expect(diff[0].type).toBe('remove');
    expect(diff[1].type).toBe('add');
  });

  it('should handle addition only', () => {
    const diff = computeDiff('', 'new line');
    expect(diff.length).toBe(1);
    expect(diff[0].type).toBe('add');
  });

  it('should handle removal only', () => {
    const diff = computeDiff('old line', '');
    expect(diff.length).toBe(1);
    expect(diff[0].type).toBe('remove');
  });

  it('should assign correct line numbers', () => {
    const diff = computeDiff('a\nb\nc', 'a\nx\nc');
    const context = diff.filter(d => d.type === 'context');
    expect(context[0].oldLineNum).toBe(1);
    expect(context[0].newLineNum).toBe(1);
  });

  it('should handle multiline diffs', () => {
    const diff = computeDiff('a\nb\nc', 'x\ny\nz');
    expect(diff.length).toBe(6); // 3 removes + 3 adds
  });

  it('should handle empty inputs', () => {
    const diff = computeDiff('', '');
    expect(diff).toEqual([]);
  });

  it('should handle longer new text', () => {
    const diff = computeDiff('a', 'a\nb\nc');
    const adds = diff.filter(d => d.type === 'add');
    expect(adds.length).toBeGreaterThanOrEqual(2);
  });

  it('should handle longer old text', () => {
    const diff = computeDiff('a\nb\nc', 'a');
    const removes = diff.filter(d => d.type === 'remove');
    expect(removes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('renderDiffLines bare mode', () => {
  it('should render in bare mode format', () => {
    vi.mocked(isBareMode).mockReturnValue(true);
    const lines = [
      { type: 'add' as const, content: 'new line' },
      { type: 'remove' as const, content: 'old line' },
      { type: 'context' as const, content: 'same line' },
    ];
    const output = renderDiffLines(lines);
    expect(output).toContain('+ new line');
    expect(output).toContain('- old line');
    expect(output).toContain('  same line');
    vi.mocked(isBareMode).mockReturnValue(false);
  });

  it('should truncate in bare mode', () => {
    vi.mocked(isBareMode).mockReturnValue(true);
    const lines = Array.from({ length: 100 }, (_, i) => ({
      type: 'context' as const,
      content: `line ${i}`,
    }));
    const output = renderDiffLines(lines, 10);
    const outputLines = output.split('\n');
    expect(outputLines.length).toBe(10);
    vi.mocked(isBareMode).mockReturnValue(false);
  });
});

describe('renderMultiFileDiff edge cases', () => {
  it('should handle invalid activeIndex', () => {
    const diff: FileDiff = {
      filePath: 'test.ts',
      oldContent: 'old',
      newContent: 'new',
      accepted: false,
      rejected: false,
    };
    const output = renderMultiFileDiff([diff], 99);
    expect(output).toBe('');
  });

  it('should render context lines', () => {
    const diff: FileDiff = {
      filePath: 'test.ts',
      oldContent: 'line1\nline2\nline3',
      newContent: 'line1\nline2\nline3',
      accepted: false,
      rejected: false,
    };
    const output = renderMultiFileDiff([diff], 0);
    expect(output).toContain('line1');
  });

  it('should handle long lines with truncation', () => {
    const longLine = 'x'.repeat(200);
    const diff: FileDiff = {
      filePath: 'test.ts',
      oldContent: longLine,
      newContent: longLine + '\nextra',
      accepted: false,
      rejected: false,
    };
    const output = renderMultiFileDiff([diff], 0, { maxWidth: 40 });
    // The ellipsis character is used for truncation
    expect(output).toContain('…');
  });
});
