// MIXED (T7 triage): the InputState machine (createInputState, insertChar,
// cursor/word ops, toggleSteerMode…) is LIVE pure logic driving AppRoot's
// editor. renderInputBox below is a LEGACY string renderer kept only for its
// unit tests — the live editor is drawn by ink components, not this function.
import chalk from 'chalk';
import type { Theme } from '../theme';
import { moveCursorVisualDown, moveCursorVisualUp, cursorVisualRow, locateCursor, toVisualLines } from '../visual-lines';

const MIN_VISIBLE_LINES = 3;
const MAX_VISIBLE_LINES = 15;

export interface InputState {
  text: string;
  cursorPos: number;
  historyIndex: number;
  steerMode?: boolean;
}

export function createInputState(): InputState {
  return { text: '', cursorPos: 0, historyIndex: -1, steerMode: false };
}

export function toggleSteerMode(state: InputState): InputState {
  return { ...state, steerMode: !state.steerMode };
}

// ── Cursor / line utilities ──

export interface CursorLineCol {
  line: number;
  col: number;
}

export function getCursorLineCol(state: InputState): CursorLineCol {
  let line = 0;
  let col = 0;
  for (let i = 0; i < state.cursorPos && i < state.text.length; i++) {
    if (state.text[i] === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

export function getLineCount(state: InputState): number {
  let count = 1;
  for (const ch of state.text) {
    if (ch === '\n') count++;
  }
  return count;
}

/** Get the flat offset of the start of a given line (0-indexed). */
function lineStartOffset(text: string, line: number): number {
  let currentLine = 0;
  for (let i = 0; i < text.length; i++) {
    if (currentLine === line) return i;
    if (text[i] === '\n') currentLine++;
  }
  return text.length;
}

/** Get the flat offset of the end of a given line (before \n or EOF). */
function lineEndOffset(text: string, line: number): number {
  let currentLine = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      if (currentLine === line) return i;
      currentLine++;
    }
  }
  return text.length;
}

// ── Mutations (immutable-style, return new state) ──

export function insertChar(state: InputState, char: string): InputState {
  const text = state.text.slice(0, state.cursorPos) + char + state.text.slice(state.cursorPos);
  // Advance cursor by UTF-16 code-unit count to stay consistent with the
  // code-unit-based slicing used everywhere else (deleteBefore, moveCursor*,
  // Editor.tsx). This keeps multi-character IME input (e.g. "你好") and astral
  // characters (e.g. emoji) aligned with how the text is indexed.
  return { ...state, text, cursorPos: state.cursorPos + char.length };
}

export function deleteBefore(state: InputState): InputState {
  if (state.cursorPos <= 0) return state;
  const text = state.text.slice(0, state.cursorPos - 1) + state.text.slice(state.cursorPos);
  return { ...state, text, cursorPos: state.cursorPos - 1 };
}

export function deleteAfter(state: InputState): InputState {
  if (state.cursorPos >= state.text.length) return state;
  const text = state.text.slice(0, state.cursorPos) + state.text.slice(state.cursorPos + 1);
  return { ...state, text };
}

export function insertNewline(state: InputState): InputState {
  return insertChar(state, '\n');
}

/**
 * Insert a (possibly multi-line) string at the cursor. CRLF/CR are normalized
 * to LF: terminals deliver clipboard newlines as \r inside bracketed paste.
 */
export function insertText(state: InputState, text: string): InputState {
  const normalized = text.replace(/\r\n?/g, '\n');
  const joined =
    state.text.slice(0, state.cursorPos) + normalized + state.text.slice(state.cursorPos);
  return { ...state, text: joined, cursorPos: state.cursorPos + normalized.length };
}

/** True when the caret sits on the first logical line (↑ falls back to history recall). */
export function isCursorOnFirstLine(state: InputState): boolean {
  return !state.text.slice(0, state.cursorPos).includes('\n');
}

/** True when the caret sits on the last logical line (↓ falls back to history recall). */
export function isCursorOnLastLine(state: InputState): boolean {
  return !state.text.slice(state.cursorPos).includes('\n');
}

/**
 * Visual-row boundary checks: with wrapping active (screenWidth > 0) the
 * caret moves between wrapped rows, so history recall must fire only at the
 * first/last VISUAL row. screenWidth <= 0 falls back to the logical-line
 * checks (legacy behavior, used by unit tests and pre-measurement callers).
 */
export function isCursorOnFirstVisualRow(state: InputState, screenWidth: number): boolean {
  if (screenWidth <= 0) return isCursorOnFirstLine(state);
  return cursorVisualRow(state.text, state.cursorPos, screenWidth) === 0;
}

export function isCursorOnLastVisualRow(state: InputState, screenWidth: number): boolean {
  if (screenWidth <= 0) return isCursorOnLastLine(state);
  const rows = toVisualLines(state.text, screenWidth);
  return locateCursor(rows, state.cursorPos).row >= rows.length - 1;
}

export function moveCursorLeft(state: InputState): InputState {
  if (state.cursorPos <= 0) return state;
  return { ...state, cursorPos: state.cursorPos - 1 };
}

export function moveCursorRight(state: InputState): InputState {
  if (state.cursorPos >= state.text.length) return state;
  return { ...state, cursorPos: state.cursorPos + 1 };
}

export function moveCursorUp(state: InputState, screenWidth: number): InputState {
  // With wrapping active, ↑/↓ step through VISUAL rows of a wrapped line;
  // screenWidth <= 0 keeps the logical-line movement (legacy callers).
  if (screenWidth > 0) {
    return { ...state, cursorPos: moveCursorVisualUp(state.text, state.cursorPos, screenWidth) };
  }
  const { line, col } = getCursorLineCol(state);
  if (line <= 0) return state;
  const prevLine = line - 1;
  const prevLineEnd = lineEndOffset(state.text, prevLine);
  const prevLineStart = lineStartOffset(state.text, prevLine);
  const prevLineLen = prevLineEnd - prevLineStart;
  const targetCol = Math.min(col, prevLineLen);
  return { ...state, cursorPos: prevLineStart + targetCol };
}

export function moveCursorDown(state: InputState, screenWidth: number): InputState {
  if (screenWidth > 0) {
    return { ...state, cursorPos: moveCursorVisualDown(state.text, state.cursorPos, screenWidth) };
  }
  const { line, col } = getCursorLineCol(state);
  const totalLines = getLineCount(state);
  if (line >= totalLines - 1) return state;
  const nextLine = line + 1;
  const nextLineEnd = lineEndOffset(state.text, nextLine);
  const nextLineStart = lineStartOffset(state.text, nextLine);
  const nextLineLen = nextLineEnd - nextLineStart;
  const targetCol = Math.min(col, nextLineLen);
  return { ...state, cursorPos: nextLineStart + targetCol };
}

export function moveToLineStart(state: InputState): InputState {
  const { line } = getCursorLineCol(state);
  return { ...state, cursorPos: lineStartOffset(state.text, line) };
}

export function moveToLineEnd(state: InputState): InputState {
  const { line } = getCursorLineCol(state);
  return { ...state, cursorPos: lineEndOffset(state.text, line) };
}

export function deleteWordBefore(state: InputState): InputState {
  let pos = state.cursorPos;
  while (pos > 0 && state.text[pos - 1] === ' ') pos--;
  while (pos > 0 && state.text[pos - 1] !== ' ') pos--;
  const text = state.text.slice(0, pos) + state.text.slice(state.cursorPos);
  return { ...state, text, cursorPos: pos };
}

export function deleteToLineStart(state: InputState): InputState {
  const { line } = getCursorLineCol(state);
  const start = lineStartOffset(state.text, line);
  const text = state.text.slice(0, start) + state.text.slice(state.cursorPos);
  return { ...state, text, cursorPos: start };
}

export function deleteToLineEnd(state: InputState): InputState {
  const { line } = getCursorLineCol(state);
  const end = lineEndOffset(state.text, line);
  const text = state.text.slice(0, state.cursorPos) + state.text.slice(end);
  return { ...state, text };
}

// ── Rendering ──

export function renderInputBox(
  state: InputState,
  prompt: string = 'kc>',
  theme?: Theme,
  maxWidth: number = 80,
): string[] {
  const tokens = theme?.resolve();
  const prefix = state.steerMode
    ? (tokens ? tokens['input.steer']('steer> ') : chalk.yellow.bold('steer> '))
    : (tokens ? tokens['input.prompt'](`${prompt} `) : chalk.cyan.bold(`${prompt} `));
  const contPrefix = ' '.repeat(stripAnsi(prefix).length);

  // Split text into lines
  const rawLines = state.text.split('\n');
  const wrappedLines: string[] = [];

  for (let i = 0; i < rawLines.length; i++) {
    const isFirstLine = i === 0;
    const linePrefix = isFirstLine ? prefix : contPrefix;
    const prefixLen = stripAnsi(linePrefix).length;
    const availWidth = Math.max(10, maxWidth - prefixLen);

    if (rawLines[i].length === 0) {
      wrappedLines.push(linePrefix);
    } else {
      let remaining = rawLines[i];
      while (remaining.length > 0) {
        const chunk = remaining.slice(0, availWidth);
        remaining = remaining.slice(availWidth);
        const pre = wrappedLines.length === 0 ? prefix : contPrefix;
        wrappedLines.push(pre + chunk);
      }
    }
  }

  // Clamp visible lines
  let startLine = 0;
  const totalLines = wrappedLines.length;
  if (totalLines > MAX_VISIBLE_LINES) {
    // Scroll to show cursor
    const { line: cursorLine } = getCursorVisualLine(state, prefix, contPrefix, maxWidth);
    startLine = Math.max(0, cursorLine - Math.floor(MAX_VISIBLE_LINES / 2));
    startLine = Math.min(startLine, totalLines - MAX_VISIBLE_LINES);
  }

  const visibleLines = wrappedLines.slice(startLine, startLine + MAX_VISIBLE_LINES);

  // Pad to minimum height
  while (visibleLines.length < MIN_VISIBLE_LINES) {
    visibleLines.push(contPrefix);
  }

  // Embed cursor position
  const { line: cursorVisual, col: cursorCol } = getCursorVisualLine(state, prefix, contPrefix, maxWidth);
  const cursorVisibleLine = cursorVisual - startLine;
  if (cursorVisibleLine >= 0 && cursorVisibleLine < visibleLines.length) {
    const line = visibleLines[cursorVisibleLine];
    const prefixLen = cursorVisibleLine === 0 ? stripAnsi(prefix).length : stripAnsi(contPrefix).length;
    const contentStart = prefixLen;
    const cursorOffset = contentStart + cursorCol;
    const plainLine = stripAnsi(line);
    if (cursorOffset >= 0 && cursorOffset <= plainLine.length) {
      const before = line.slice(0, line.length - (plainLine.length - cursorOffset));
      const at = plainLine[cursorOffset] || ' ';
      const after = line.slice(line.length - (plainLine.length - cursorOffset) + (cursorOffset < plainLine.length ? 1 : 0));
      visibleLines[cursorVisibleLine] = before + chalk.inverse(at) + after;
    }
  }

  return visibleLines;
}

// ── Helpers ──

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

function getCursorVisualLine(
  state: InputState,
  prefix: string,
  contPrefix: string,
  maxWidth: number,
): CursorLineCol {
  const { line, col } = getCursorLineCol(state);
  const prefixLen = stripAnsi(prefix).length;
  const contPrefixLen = stripAnsi(contPrefix).length;
  const availWidth = Math.max(10, maxWidth - prefixLen);
  const contAvailWidth = Math.max(10, maxWidth - contPrefixLen);

  let visualLine = 0;
  for (let i = 0; i < line; i++) {
    const rawLen = lineEndOffset(state.text, i) - lineStartOffset(state.text, i);
    if (i === 0) {
      visualLine += Math.max(1, Math.ceil(rawLen / (availWidth || 1)));
    } else {
      visualLine += Math.max(1, Math.ceil(rawLen / (contAvailWidth || 1)));
    }
  }
  // Position within the current line
  const currentLineRawLen = lineEndOffset(state.text, line) - lineStartOffset(state.text, line);
  const currentAvail = line === 0 ? availWidth : contAvailWidth;
  const wrappedLinesBefore = currentLineRawLen > 0 ? Math.floor(col / currentAvail) : 0;
  const visualCol = col % currentAvail;

  return { line: visualLine + wrappedLinesBefore, col: visualCol };
}
