/**
 * Keypress handler for raw mode stdin input.
 *
 * Parses terminal escape sequences into structured KeypressEvent objects.
 * Used by overlay components (ModelSelector, CommandPalette) that need
 * real-time arrow key navigation instead of line-based readline input.
 */

export interface KeypressEvent {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift?: boolean;
  isPrintable?: boolean;
}

/**
 * Parse a raw keypress chunk into a KeypressEvent.
 * Handles ANSI escape sequences for arrow keys and control characters.
 */
export function parseKeypress(chunk: string): KeypressEvent {
  const empty: KeypressEvent = { name: '', ctrl: false, meta: false };
  if (!chunk) return empty;

  // Shift+Enter: kitty protocol \x1B[13;2u
  if (chunk === '\x1B[13;2u') return { name: 'return', ctrl: false, meta: false, shift: true };

  // Shift+Tab: \x1B[Z
  if (chunk === '\x1B[Z') return { name: 'tab', ctrl: false, meta: false, shift: true };

  // Arrow keys: ESC [ A/B/C/D
  if (chunk === '\x1B[A') return { name: 'up', ctrl: false, meta: false };
  if (chunk === '\x1B[B') return { name: 'down', ctrl: false, meta: false };
  if (chunk === '\x1B[C') return { name: 'left', ctrl: false, meta: false };
  if (chunk === '\x1B[D') return { name: 'right', ctrl: false, meta: false };

  // Delete key: ESC [ 3 ~
  if (chunk === '\x1B[3~') return { name: 'delete', ctrl: false, meta: false };

  // Bare escape
  if (chunk === '\x1B') return { name: 'escape', ctrl: false, meta: false };

  // Enter / Return (must check before ctrl range since \r=0x0D, \n=0x0A are in 0x01-0x1A)
  if (chunk === '\r' || chunk === '\n') return { name: 'return', ctrl: false, meta: false };

  // Tab (0x09 is also in ctrl range)
  if (chunk === '\t') return { name: 'tab', ctrl: false, meta: false };

  // Control characters (Ctrl+A = 0x01, Ctrl+Z = 0x1A)
  const code = chunk.charCodeAt(0);
  if (code >= 0x01 && code <= 0x1A && chunk.length === 1) {
    const letter = String.fromCharCode(code + 96); // 0x01 → 'a', etc.
    return { name: letter, ctrl: true, meta: false };
  }

  // Backspace (DEL)
  if (chunk === '\x7F') return { name: 'backspace', ctrl: false, meta: false };

  // Regular character: IME-composed text or any printable Unicode character.
  // Use code-point count (not UTF-16 code units) so that characters outside
  // the BMP are recognized as single printable characters.
  return { name: chunk, ctrl: false, meta: false, isPrintable: isPrintableUnicode(chunk) };
}

/** Returns true when every code point in `s` is a printable (non-control) character. */
function isPrintableUnicode(s: string): boolean {
  if (!s) return false;
  for (const cp of s) {
    const code = cp.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return false;
  }
  return true;
}

/**
 * Check if a keypress should be handled by an overlay (palette/model selector).
 * Returns true for navigation keys: up, down, return, escape.
 */
export function isOverlayKey(event: KeypressEvent): boolean {
  return event.name === 'up' || event.name === 'down' ||
         event.name === 'return' || event.name === 'escape';
}

/**
 * Check if a keypress is the steer trigger (Ctrl+I).
 * This opens a mini input prompt to inject a steer message into the running agent.
 */
export function isSteerKey(event: KeypressEvent): boolean {
  return event.ctrl && event.name === 'i';
}
