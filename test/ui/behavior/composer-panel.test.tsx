/**
 * T25 phase 1 — ComposerPanel extraction (input/editor slot).
 *
 * Renders the REAL AppRoot through the behavior harness and asserts
 * user-visible composer behavior, so moving the Editor wiring into
 * src/ui/panels/ComposerPanel.tsx cannot change rendered output: typed text
 * echoes after the prompt, backspace deletes, and the trailing-backslash
 * continuation still inserts a newline instead of submitting.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('ComposerPanel (behavior)', () => {
  it('echoes typed characters after the kc> prompt', async () => {
    h = await renderApp({ width: 100, height: 30 });
    await h.type('composer probe');
    await h.waitForText('kc> composer probe');
  });

  it('deletes the character before the cursor on backspace', async () => {
    h = await renderApp({ width: 100, height: 30 });
    await h.type('composer probe');

    await h.press('\u007F'); // backspace

    await h.waitForText('kc> composer prob', 3000);
    expect(h.plainFrame()).not.toContain('probe');
  });

  it('inserts a newline for a trailing backslash instead of submitting', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('line-one\\');
    // Ensure the backslash landed in the buffer before pressing Enter — under
    // coverage instrumentation ink's render/key pipeline lags, and pressing
    // Enter against an unflushed buffer would submit instead of continuing.
    await h.waitForText('kc> line-one\\', 5000);
    await h.press(KEYS.enter); // continuation — must NOT submit
    await h.type('line-two');
    // The prompt marks the buffer's start (absolute row 0); with the row
    // window scrolled onto the second logical line, `line-two` renders with a
    // blank prefix — a `kc>` here would falsely advertise a new input start.
    await h.waitForText('line-two', 5000);

    // Nothing reached the engine yet…
    expect(engine.submittedMessages).toEqual([]);
    expect(h.plainFrame()).toContain('line-two');

    // A plain Enter now submits the composed multi-line message.
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.submittedMessages.length === 1, 5000, 'submission');
    expect(engine.submittedMessages[0]).toBe('line-one\\\nline-two');
  });
});
