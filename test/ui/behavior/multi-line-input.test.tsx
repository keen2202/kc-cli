/**
 * Multi-line input (behavior) — renders the REAL AppRoot and locks the
 * composer's multi-line contract:
 * - Ctrl+J (linefeed) inserts a newline without submitting (works on every
 *   terminal, unlike Shift+Enter which needs the kitty protocol);
 * - bracketed paste lands multi-line clipboard text in the buffer as one
 *   insertion instead of tripping Enter-submit / control-char drops;
 * - ↑/↓ move the caret between lines of a multi-line buffer and only fall
 *   back to history recall at the first/last line (single-line unchanged).
 *
 * Note on rendering: the editor prompt prefix ('kc> ') is drawn on the FIRST
 * visible input line only; continuation lines carry a 4-space plain prefix.
 * Submitted turns are scripted with a trailing turn_complete so isStreaming
 * resets (a real engine always closes its turn with that event).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('multi-line input (behavior)', () => {
  it('inserts a newline on Ctrl+J without submitting, then submits both lines', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({ width: 100, height: 40, engine });

    await h.type('line-one');
    await h.press(KEYS.ctrlJ);
    await h.type('line-two');
    await h.waitForText('kc> line-one', 5000);
    await h.waitForText('line-two', 5000);

    // Nothing reached the engine yet — the newline did not submit.
    expect(engine.submittedMessages).toEqual([]);

    await h.press(KEYS.enter);
    await h.waitFor(() => engine.submittedMessages.length === 1, 5000, 'submission');
    expect(engine.submittedMessages[0]).toBe('line-one\nline-two');
  });

  it('renders the continuation line under the prompt after Ctrl+J', async () => {
    h = await renderApp({ width: 100, height: 40 });
    await h.type('a');
    await h.press(KEYS.ctrlJ);
    await h.type('b');
    await h.waitForText('kc> a', 5000);
    await h.waitForText('b', 5000);
    // The continuation line renders in the left pane with a plain (promptless)
    // prefix — strip the sidebar column, then check the bare continuation row.
    const leftPane = h.lines().map((l) => l.split('││')[0]!.trimEnd());
    expect(leftPane.some((l) => /^│\s+b$/.test(l))).toBe(true);
  });

  it('inserts bracketed-paste multi-line text without submitting', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({ width: 100, height: 40, engine });

    // A real terminal wraps clipboard content in bracketed-paste markers and
    // sends clipboard newlines as \r.
    await h.press('\u001B[200~pasted-one\rpasted-two\u001B[201~');
    await h.waitForText('pasted-one', 5000);
    await h.waitForText('pasted-two', 5000);

    expect(engine.submittedMessages).toEqual([]);

    await h.press(KEYS.enter);
    await h.waitFor(() => engine.submittedMessages.length === 1, 5000, 'submission');
    expect(engine.submittedMessages[0]).toBe('pasted-one\npasted-two');
  });

  it('moves the caret with ↑/↓ inside a multi-line buffer; history only at the boundary', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({ width: 100, height: 40, engine });

    // Seed history with one entry; the scripted turn_complete resets
    // isStreaming so the 'input' keybinding context is active afterwards.
    engine.scriptEvents([{ type: 'turn_complete' }]);
    await h.type('history-entry');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.submittedMessages.length === 1, 5000, 'seed submission');

    // Compose a two-line buffer; the caret ends on the last line.
    await h.type('aa');
    await h.press(KEYS.ctrlJ);
    await h.type('bb');
    await h.waitForText('kc> aa', 5000);
    await h.waitForText('bb', 5000);

    // ↑ from the last line moves the caret (buffer intact, NO history recall).
    await h.press(KEYS.up);
    await h.waitForText('kc> aa', 5000);
    expect(h.plainFrame()).toContain('bb');

    // ↑ again — caret now on the first line — falls back to history recall,
    // replacing the buffer with the previous entry.
    await h.press(KEYS.up);
    await h.waitForText('kc> history-entry', 5000);
    expect(h.plainFrame()).not.toContain('bb');
  });

  it('recalls history immediately on ↑ for single-line input (unchanged)', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({ width: 100, height: 40, engine });

    engine.scriptEvents([{ type: 'turn_complete' }]);
    await h.type('older-msg');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.submittedMessages.length === 1, 5000, 'seed submission');

    await h.press(KEYS.up);
    await h.waitForText('kc> older-msg', 5000);
  });
});
