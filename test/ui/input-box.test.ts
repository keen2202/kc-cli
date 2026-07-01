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
  moveCursorLeft,
  moveCursorRight,
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
