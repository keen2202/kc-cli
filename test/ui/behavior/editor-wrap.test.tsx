/**
 * Editor wrapping behavior: typed text that exceeds the composer's column
 * budget must soft-wrap onto further visual rows (no horizontal truncation),
 * with the prompt prefix only on the buffer's first row and ↑/↓ navigating
 * the wrapped rows before falling back to history recall.
 *
 * Payload uses 'z' — a character absent from the surrounding UI chrome — so
 * occurrence counts over the whole frame isolate the typed buffer.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

// Large enough for the editor's row window to show several wrapped rows
// (height 30 leaves a single input row after the hint/attachment chrome).
const TERM = { width: 100, height: 48 } as const;

describe('editor wrap (behavior)', () => {
  it('wraps an over-long single-line input onto a second visual row', async () => {
    h = await renderApp({ ...TERM });

    // Long enough to exceed the column budget at width 100 (sidebar included).
    const text = 'z'.repeat(120);
    await h.type(text);

    // The full text must stay visible across wrapped rows — the old editor
    // truncated each logical line to the column budget instead.
    await h.waitFor(() => {
      const count = (h!.plainFrame().match(/z/g) ?? []).length;
      return count === text.length;
    }, 5000, 'all typed characters to stay visible (wrapped, not truncated)');

    // The wrapped continuation row renders with a blank prefix: it does not
    // start with the prompt.
    const lines = h.lines();
    const promptRow = lines.find((l) => l.includes('kc> '));
    expect(promptRow).toBeDefined();
    const wrappedRow = lines.find((l) => l.includes('zzzz') && !l.includes('kc> '));
    expect(wrappedRow).toBeDefined();
  });

  it('keeps CJK input fully visible across wrapped rows', async () => {
    h = await renderApp({ ...TERM });

    // 60 CJK characters = 120 display columns — must wrap into 2+ rows, and
    // every character must survive rendering.
    const text = '你'.repeat(60);
    await h.type(text);

    await h.waitFor(() => {
      const count = (h!.plainFrame().match(/你/g) ?? []).length;
      return count === text.length;
    }, 5000, 'all CJK characters to stay visible (wrapped, not truncated)');
  });

  it('moves the caret up through a wrapped row and inserts mid-buffer', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({ ...TERM, engine });

    // Wraps into multiple rows at width 100. Cursor sits at the very end.
    const text = 'z'.repeat(120);
    await h.type(text);
    await h.waitFor(() => (h!.plainFrame().match(/z/g) ?? []).length === 120, 5000, 'wrap settled');

    // ↑ navigates from the last wrapped row to the one above (NOT history
    // recall — the buffer is a single logical line, so the old logical-line
    // boundary check would have replaced the draft). Typing afterwards must
    // insert mid-buffer, proving the caret moved between visual rows.
    await h.press(KEYS.up);
    await h.type('X');
    await h.waitForText('X', 5000);

    await h.press(KEYS.enter);
    await h.waitFor(() => engine.submittedMessages.length === 1, 5000, 'submission');
    const submitted = engine.submittedMessages[0]!;
    expect(submitted).toHaveLength(text.length + 1);
    expect(submitted).toContain('X');
    // Insertion landed mid-buffer: the caret left the buffer end.
    expect(submitted.endsWith('X')).toBe(false);
    expect(submitted.startsWith('X')).toBe(false);
  });

  it('falls back to history recall from a single-row buffer', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({ width: 60, height: 30, engine });

    // Turn 1 completes, populating history.
    engine.scriptEvents([{ type: 'text_delta', text: 'earlier answer' }]);
    await h.type('first message');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'first turn');
    await h.waitForText('earlier answer');

    // A short (single visual row) buffer: ↑ must recall history exactly as
    // before — wrapping must not change the boundary behavior.
    await h.type('draft');
    await h.waitForText('kc> draft', 5000);
    await h.press(KEYS.up);
    await h.waitForText('first message', 5000);
  });
});
