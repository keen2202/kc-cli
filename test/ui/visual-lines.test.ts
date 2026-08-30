/**
 * Unit tests for the composer's visual-line model (src/ui/visual-lines.ts):
 * hard wrapping at a display-column budget (CJK/emoji aware), cursor offset ↔
 * visual (row, col) mapping, and wrapped-row caret movement.
 */

import { describe, it, expect } from 'vitest';
import {
  toVisualLines,
  locateCursor,
  countVisualRows,
  cursorVisualRow,
  moveCursorVisualUp,
  moveCursorVisualDown,
} from '../../src/ui/visual-lines';

describe('toVisualLines', () => {
  it('keeps a short line on a single row', () => {
    const rows = toVisualLines('hello', 20);
    expect(rows).toEqual([{ text: 'hello', startOffset: 0, logicalLine: 0 }]);
  });

  it('wraps ASCII at the column budget, preserving every character', () => {
    const text = 'a'.repeat(25);
    const rows = toVisualLines(text, 10);
    expect(rows.map((r) => r.text)).toEqual(['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)]);
    // Offsets walk the buffer in order.
    expect(rows.map((r) => r.startOffset)).toEqual([0, 10, 20]);
    expect(rows.map((r) => r.logicalLine)).toEqual([0, 0, 0]);
  });

  it('wraps CJK text by display width (2 columns per char)', () => {
    const text = '你'.repeat(12);
    const rows = toVisualLines(text, 10);
    expect(rows.map((r) => r.text)).toEqual(['你'.repeat(5), '你'.repeat(5), '你'.repeat(2)]);
  });

  it('wraps mixed CJK/ASCII by display width without dropping characters', () => {
    const text = '汉字abc混合mixed文字123';
    for (const cols of [4, 7, 13]) {
      const rows = toVisualLines(text, cols);
      expect(rows.map((r) => r.text).join('')).toBe(text);
      for (const r of rows) expect(r.logicalLine).toBe(0);
    }
  });

  it('splits logical lines and accounts for the newline offset', () => {
    const rows = toVisualLines('abc\nxyz', 10);
    expect(rows).toEqual([
      { text: 'abc', startOffset: 0, logicalLine: 0 },
      { text: 'xyz', startOffset: 4, logicalLine: 1 },
    ]);
  });

  it('renders empty logical lines as empty rows', () => {
    const rows = toVisualLines('a\n\nb', 10);
    expect(rows.map((r) => r.text)).toEqual(['a', '', 'b']);
    expect(rows.map((r) => r.startOffset)).toEqual([0, 2, 3]);
    expect(rows.map((r) => r.logicalLine)).toEqual([0, 1, 2]);
  });

  it('yields one empty row for an empty buffer', () => {
    expect(toVisualLines('', 10)).toEqual([{ text: '', startOffset: 0, logicalLine: 0 }]);
  });
});

describe('locateCursor', () => {
  const rows = toVisualLines('a'.repeat(25), 10);

  it('maps the start of the buffer to row 0, col 0', () => {
    expect(locateCursor(rows, 0)).toEqual({ row: 0, col: 0 });
  });

  it('maps mid-buffer offsets onto the owning row', () => {
    expect(locateCursor(rows, 12)).toEqual({ row: 1, col: 2 });
  });

  it('maps a row-boundary offset to column 0 of the following row', () => {
    expect(locateCursor(rows, 10)).toEqual({ row: 1, col: 0 });
  });

  it('maps the end offset past the last character', () => {
    expect(locateCursor(rows, 25)).toEqual({ row: 2, col: 5 });
  });
});

describe('countVisualRows / cursorVisualRow', () => {
  it('counts wrapped rows and locates the cursor row', () => {
    const text = 'a'.repeat(21);
    expect(countVisualRows(text, 10)).toBe(3);
    expect(cursorVisualRow(text, 0, 10)).toBe(0);
    expect(cursorVisualRow(text, 15, 10)).toBe(1);
    expect(cursorVisualRow(text, 21, 10)).toBe(2);
  });

  it('reports a single row for a short single-line buffer', () => {
    expect(countVisualRows('short', 40)).toBe(1);
    expect(cursorVisualRow('short', 5, 40)).toBe(0);
  });
});

describe('moveCursorVisualUp / moveCursorVisualDown', () => {
  const text = 'b' + 'a'.repeat(19); // rows of 10: 'baaaaaaaaa', 'aaaaaaaaab'? no — 'b' + 19 a
  // rows: [0..9] = 'b'+9a, [10..19] = 10 a
  it('moves up from the second visual row keeping the column', () => {
    // Cursor at offset 15 → row 1 col 5. Up → row 0 col 5 → offset 5.
    expect(moveCursorVisualUp(text, 15, 10)).toBe(5);
  });

  it('clamps the column to the target row length', () => {
    // Cursor at end (offset 20, row 1 col 10). Up → row 0 (len 10) col 10 → clamped to 10.
    expect(moveCursorVisualUp(text, 20, 10)).toBe(10);
  });

  it('is a no-op on the first visual row', () => {
    expect(moveCursorVisualUp(text, 3, 10)).toBe(3);
  });

  it('moves down symmetrically and is a no-op on the last row', () => {
    expect(moveCursorVisualDown(text, 5, 10)).toBe(15);
    expect(moveCursorVisualDown(text, 18, 10)).toBe(18);
  });

  it('moves between logical lines through their visual rows', () => {
    const multi = 'a'.repeat(15) + '\nxyz';
    // Cursor on 'z' (offset 18, row col 2), down → no-op (last row).
    expect(moveCursorVisualDown(multi, 18, 10)).toBe(18);
    // Cursor on 'z' (col 2), up → second row of line 0 ('a'.repeat(5)) at col 2 → offset 12.
    expect(moveCursorVisualUp(multi, 18, 10)).toBe(12);
  });
});
