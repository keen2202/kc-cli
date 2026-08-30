/**
 * Visual-line model for the composer (and any width-constrained single-line
 * editor): hard-wraps logical lines at a display-column budget and maps
 * between cursor offsets and visual (row, col) positions.
 *
 * Wrapping goes through wrap-ansi with {hard, trim:false} so rows preserve
 * every input character in order (`rows.join('') === logical line`) and wide
 * characters (CJK, emoji) count as 2 display columns — matching how the
 * transcript renders. All offsets are UTF-16 code-unit indices, the same
 * unit the InputState cursor uses.
 */

import wrapAnsi from 'wrap-ansi';

/** One rendered row: its text, buffer offset of its first char, logical line. */
export interface VisualLine {
  text: string;
  /** UTF-16 offset of this row's first character within the full buffer text. */
  startOffset: number;
  /** 0-based logical line index this row belongs to. */
  logicalLine: number;
}

export interface CursorVisualPos {
  /** 0-based visual row index. */
  row: number;
  /** UTF-16 offset of the cursor from the row's first character. */
  col: number;
}

const WRAP_OPTIONS = { hard: true, trim: false } as const;

/** Split one logical line (no '\n') into visual rows at `columns`. */
function wrapLogicalLine(line: string, columns: number): string[] {
  if (line.length === 0) return [''];
  const wrapped = wrapAnsi(line, columns, WRAP_OPTIONS);
  return wrapped.split('\n');
}

/**
 * Split buffer text into visual rows. An empty buffer yields one empty row so
 * the editor always has a row to draw the caret on.
 */
export function toVisualLines(text: string, columns: number): VisualLine[] {
  const cols = Math.max(1, columns);
  const rows: VisualLine[] = [];
  let offset = 0;
  const logicalLines = text.split('\n');
  for (let i = 0; i < logicalLines.length; i++) {
    const parts = wrapLogicalLine(logicalLines[i]!, cols);
    for (const part of parts) {
      rows.push({ text: part, startOffset: offset, logicalLine: i });
      offset += part.length;
    }
    // The newline itself belongs to the end of this logical line; the next
    // line's rows start after it.
    offset += 1;
  }
  if (rows.length === 0) rows.push({ text: '', startOffset: 0, logicalLine: 0 });
  return rows;
}

/** Map a cursor offset to its visual row and column-within-row. */
export function locateCursor(rows: VisualLine[], cursorPos: number): CursorVisualPos {
  // The last row whose startOffset is <= cursorPos owns the caret: an offset
  // at a row boundary renders at column 0 of the following row, and an offset
  // at a logical-line boundary renders at the start of the next line's rows.
  let row = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.startOffset <= cursorPos) row = i;
    else break;
  }
  return { row, col: cursorPos - rows[row]!.startOffset };
}

/**
 * Row index of the cursor — convenience over toVisualLines + locateCursor.
 */
export function cursorVisualRow(text: string, cursorPos: number, columns: number): number {
  return locateCursor(toVisualLines(text, columns), cursorPos).row;
}

/** Total number of visual rows the buffer occupies at `columns`. */
export function countVisualRows(text: string, columns: number): number {
  return toVisualLines(text, columns).length;
}

/**
 * Offset after moving the caret up one visual row, keeping the character
 * column (clamped to the target row's length). Returns the input offset
 * unchanged when already on the first row.
 */
export function moveCursorVisualUp(text: string, cursorPos: number, columns: number): number {
  const rows = toVisualLines(text, columns);
  const { row, col } = locateCursor(rows, cursorPos);
  if (row <= 0) return cursorPos;
  const target = rows[row - 1]!;
  return target.startOffset + Math.min(col, target.text.length);
}

/**
 * Offset after moving the caret down one visual row, keeping the character
 * column (clamped to the target row's length). Returns the input offset
 * unchanged when already on the last row.
 */
export function moveCursorVisualDown(text: string, cursorPos: number, columns: number): number {
  const rows = toVisualLines(text, columns);
  const { row, col } = locateCursor(rows, cursorPos);
  if (row >= rows.length - 1) return cursorPos;
  const target = rows[row + 1]!;
  return target.startOffset + Math.min(col, target.text.length);
}
