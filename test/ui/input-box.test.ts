/**
 * Tests for InputBox component.
 */

import { describe, it, expect } from 'vitest';
import {
  renderInputBox,
  createInputState,
  insertChar,
  deleteBefore,
  insertNewline,
  insertText,
  isCursorOnFirstLine,
  isCursorOnLastLine,
  moveCursorLeft,
  moveCursorRight,
  moveCursorUp,
  moveCursorDown,
  getCursorLineCol,
  getLineCount,
  type InputState,
} from '../../src/ui/components/InputBox';

describe('InputBox — createInputState', () => {
  it('returns default state with empty text', () => {
    const state = createInputState();
    expect(state.text).toBe('');
    expect(state.cursorPos).toBe(0);
    expect(state.historyIndex).toBe(-1);
  });

  it('returns a fresh state each time', () => {
    const state1 = createInputState();
    const state2 = createInputState();
    expect(state1).not.toBe(state2);
    expect(state1).toEqual(state2);
  });
});

describe('InputBox — mutations', () => {
  it('insertChar inserts at cursor position', () => {
    let state = createInputState();
    state = insertChar(state, 'h');
    state = insertChar(state, 'i');
    expect(state.text).toBe('hi');
    expect(state.cursorPos).toBe(2);
  });

  it('deleteBefore removes char before cursor', () => {
    let state = createInputState();
    state = insertChar(state, 'a');
    state = insertChar(state, 'b');
    state = deleteBefore(state);
    expect(state.text).toBe('a');
    expect(state.cursorPos).toBe(1);
  });

  it('deleteBefore does nothing at position 0', () => {
    const state = createInputState();
    const next = deleteBefore(state);
    expect(next.text).toBe('');
    expect(next.cursorPos).toBe(0);
  });

  it('insertNewline inserts \\n', () => {
    let state = createInputState();
    state = insertChar(state, 'a');
    state = insertNewline(state);
    state = insertChar(state, 'b');
    expect(state.text).toBe('a\nb');
    expect(getLineCount(state)).toBe(2);
  });

  it('moveCursorLeft/Right navigate within text', () => {
    let state = createInputState();
    state = insertChar(state, 'a');
    state = insertChar(state, 'b');
    state = insertChar(state, 'c');
    // cursor at end (pos 3)
    state = moveCursorLeft(state);
    expect(state.cursorPos).toBe(2);
    state = moveCursorRight(state);
    expect(state.cursorPos).toBe(3);
  });

  it('getCursorLineCol returns correct values', () => {
    let state = createInputState();
    state = insertChar(state, 'a');
    state = insertChar(state, 'b');
    state = insertNewline(state);
    state = insertChar(state, 'c');
    // text: "ab\nc", cursor at pos 4 (line 1, col 1)
    const { line, col } = getCursorLineCol(state);
    expect(line).toBe(1);
    expect(col).toBe(1);
  });

  it('insertChar inserts a multi-character IME phrase (Chinese)', () => {
    let state = createInputState();
    state = insertChar(state, '你好');
    expect(state.text).toBe('你好');
    // cursor advances by code-unit count (BMP CJK => 2)
    expect(state.cursorPos).toBe(2);
  });

  it('insertChar keeps cursorPos aligned with text length for astral chars', () => {
    let state = createInputState();
    state = insertChar(state, '😀'); // emoji (surrogate pair, length 2)
    expect(state.cursorPos).toBe(state.text.length);
    expect(state.cursorPos).toBe(2);
  });

  it('deleteBefore removes a single Chinese character correctly', () => {
    let state = createInputState();
    state = insertChar(state, '你好');
    state = deleteBefore(state);
    expect(state.text).toBe('你');
    expect(state.cursorPos).toBe(1);
  });

  it('moveCursorLeft/Right navigate over Chinese text', () => {
    let state = createInputState();
    state = insertChar(state, '你好');
    state = moveCursorLeft(state);
    expect(state.cursorPos).toBe(1);
    state = insertChar(state, '好'); // insert between the two chars
    expect(state.text).toBe('你好好');
    expect(state.cursorPos).toBe(2);
  });
});

describe('InputBox — renderInputBox', () => {
  it('renders with default kc> prompt', () => {
    const state = createInputState();
    const lines = renderInputBox(state);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines[0]).toContain('kc>');
  });

  it('renders with custom prompt', () => {
    const state = createInputState();
    const lines = renderInputBox(state, 'custom>');
    expect(lines[0]).toContain('custom>');
  });

  it('renders typed text', () => {
    const state: InputState = {
      text: 'hello world',
      cursorPos: 11,
      historyIndex: -1,
    };
    const lines = renderInputBox(state);
    const joined = lines.join('');
    expect(joined).toContain('hello world');
    expect(joined).toContain('kc>');
  });

  it('renders empty input with min height', () => {
    const state = createInputState();
    const lines = renderInputBox(state);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    const joined = lines.join('');
    expect(joined).toContain('kc>');
  });

  it('renders multi-line input', () => {
    const state: InputState = {
      text: 'line1\nline2\nline3',
      cursorPos: 17,
      historyIndex: -1,
    };
    const lines = renderInputBox(state);
    const joined = lines.join('\n');
    expect(joined).toContain('line1');
    expect(joined).toContain('line2');
    expect(joined).toContain('line3');
  });

  it('handles special characters in text', () => {
    const state: InputState = {
      text: 'test with "quotes" and <brackets>',
      cursorPos: 34,
      historyIndex: -1,
    };
    const lines = renderInputBox(state);
    const joined = lines.join('');
    expect(joined).toContain('"quotes"');
    expect(joined).toContain('<brackets>');
  });
});

describe('InputBox — multi-line text insertion (bracketed paste)', () => {
  it('insertText inserts multi-line text at the cursor', () => {
    let state = createInputState();
    state = insertChar(state, 'a');
    state = insertText(state, 'one\ntwo');
    expect(state.text).toBe('aone\ntwo');
    expect(state.cursorPos).toBe(8);
  });

  it('insertText normalizes CRLF and bare CR to LF', () => {
    let state = createInputState();
    state = insertText(state, 'x\r\ny\rz');
    expect(state.text).toBe('x\ny\nz');
  });

  it('insertText keeps trailing text after the cursor intact', () => {
    let state: InputState = { text: 'ab', cursorPos: 1, historyIndex: -1 };
    state = insertText(state, 'X\nY');
    expect(state.text).toBe('aX\nYb');
    expect(state.cursorPos).toBe(4);
  });
});

describe('InputBox — cursor line boundaries', () => {
  it('reports first/last line for single-line text on both boundaries', () => {
    const start: InputState = { text: 'abc', cursorPos: 0, historyIndex: -1 };
    const end: InputState = { text: 'abc', cursorPos: 3, historyIndex: -1 };
    expect(isCursorOnFirstLine(start)).toBe(true);
    expect(isCursorOnLastLine(start)).toBe(true);
    expect(isCursorOnFirstLine(end)).toBe(true);
    expect(isCursorOnLastLine(end)).toBe(true);
  });

  it('reports interior lines of a multi-line buffer', () => {
    const state: InputState = { text: 'aa\nbb\ncc', cursorPos: 3, historyIndex: -1 };
    // cursorPos 3 = start of line 1 ('bb')
    expect(isCursorOnFirstLine(state)).toBe(false);
    expect(isCursorOnLastLine(state)).toBe(false);
    expect(isCursorOnFirstLine({ ...state, cursorPos: 1 })).toBe(true);
    expect(isCursorOnLastLine({ ...state, cursorPos: 8 })).toBe(true);
  });

  it('moveCursorUp/Down keep the column clamp within line length', () => {
    let state: InputState = { text: 'aaaa\nb\ncccc', cursorPos: 10, historyIndex: -1 };
    state = moveCursorUp(state, 0);
    expect(getCursorLineCol(state)).toEqual({ line: 1, col: 1 });
    state = moveCursorUp(state, 0);
    expect(getCursorLineCol(state)).toEqual({ line: 0, col: 1 });
    state = moveCursorDown(state, 0);
    expect(getCursorLineCol(state)).toEqual({ line: 1, col: 1 });
    state = moveCursorDown(state, 0);
    expect(getCursorLineCol(state)).toEqual({ line: 2, col: 1 });
  });
});
