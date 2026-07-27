/**
 * Chat scrolling & key-separation behavior (terminal-UI fixes #1/#3/#5).
 *
 * Through the real AppRoot tree:
 *  - long output follows the tail and shows the "↑ N more lines" indicator;
 *  - ←/PgUp scroll back through history, →/PgDn return to the tail;
 *  - ↑ recalls input history and never scrolls the chat viewport;
 *  - Shift+Tab cycles the unified mode Build → Plan → Auto → Goal → Build;
 *  - Ctrl+O expands the collapsed tool output in the transcript.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

// Raw escape sequences not covered by the harness KEYS table.
const LEFT = '\u001B[D';
const RIGHT = '\u001B[C';
const PGUP = '\u001B[5~';
const PGDN = '\u001B[6~';
const SHIFT_TAB = '\u001B[Z';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

// 60 numbered rows (zero-padded so "line-01" never substring-matches "line-10").
const LONG_BODY = Array.from({ length: 60 }, (_, i) => `line-${String(i + 1).padStart(2, '0')}`).join('\n');

/** Render the app and stream a 60-row assistant reply to overflow the chat area. */
async function renderLongTranscript(): Promise<Harness> {
  const engine = new FakeQueryEngine();
  engine.scriptEvents([
    { type: 'text_delta', text: LONG_BODY },
    { type: 'turn_complete' },
  ]);
  const harness = await renderApp({ width: 100, height: 30, engine });
  await harness.type('show lines');
  await harness.press(KEYS.enter);
  await harness.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
  await harness.waitForText('line-60', 5000);
  return harness;
}

describe('chat scrolling (behavior)', () => {
  it('follows the tail on long output and shows the ↑ indicator', async () => {
    h = await renderLongTranscript();

    const frame = h.plainFrame();
    // Tail is visible, the head is scrolled out behind the indicator.
    expect(frame).toContain('line-60');
    expect(frame).not.toContain('line-01');
    expect(frame).toMatch(/↑ \d+ more lines/);
    expect(frame).toContain('to scroll up');
  });

  it('← scrolls up line by line and → returns to the tail', async () => {
    h = await renderLongTranscript();

    // Input is empty, so ← scrolls the chat instead of moving the cursor.
    await h.press(LEFT);
    await h.press(LEFT);
    await h.press(LEFT);
    await h.waitForText('↓ 3 more lines', 3000);
    expect(h.plainFrame()).not.toContain('line-60');

    await h.press(RIGHT);
    await h.press(RIGHT);
    await h.press(RIGHT);
    await h.waitForText('line-60', 3000);
    expect(h.plainFrame()).not.toContain('to follow');
  });

  it('PgUp pages back and PgDn returns to the tail', async () => {
    h = await renderLongTranscript();

    await h.press(PGUP);
    await h.waitForText('to follow', 3000); // ↓ indicator appears
    expect(h.plainFrame()).not.toContain('line-60');

    await h.press(PGDN);
    await h.waitForText('line-60', 3000);
    expect(h.plainFrame()).not.toContain('to follow');
  });

  it('↑ recalls input history without scrolling the chat', async () => {
    h = await renderLongTranscript();

    // The submitted user message has scrolled out of the viewport.
    expect(h.plainFrame()).not.toContain('show lines');

    await h.press(KEYS.up);
    await h.waitForText('show lines', 3000); // recalled into the editor

    const frame = h.plainFrame();
    // Chat viewport did not move: still at the tail, no ↓ indicator.
    expect(frame).toContain('line-60');
    expect(frame).not.toContain('to follow');
  });
});

describe('mode cycling (behavior)', () => {
  it('Shift+Tab cycles Build → Plan → Auto → Goal → Build', async () => {
    h = await renderApp({ width: 100, height: 30 });
    await h.waitForText('Mode: Build');

    await h.press(SHIFT_TAB);
    await h.waitForText('Mode: Plan', 3000);

    await h.press(SHIFT_TAB);
    await h.waitForText('Mode: Auto', 3000);

    await h.press(SHIFT_TAB);
    await h.waitForText('Mode: Goal', 3000);

    await h.press(SHIFT_TAB);
    await h.waitForText('Mode: Build', 3000);
  });
});

describe('tool output expansion (behavior)', () => {
  it('Ctrl+O expands the collapsed tool output', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'tool_started', toolCall: { toolName: 'Bash', input: { command: 'ls' } } },
      {
        type: 'tool_completed',
        toolCall: { toolName: 'Bash' },
        result: { output: 'out-row-1\nout-row-2\nout-row-3\nout-row-4' },
        isError: false,
      },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('run ls');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('✓ Bash', 5000);

    // Collapsed by default: 2-line preview + expand hint, rest hidden.
    const collapsed = h.plainFrame();
    expect(collapsed).toContain('out-row-1');
    expect(collapsed).toContain('out-row-2');
    expect(collapsed).toContain('Ctrl+O to expand');
    expect(collapsed).not.toContain('out-row-3');

    await h.press(KEYS.ctrlO);
    await h.waitForText('out-row-3', 3000);
    expect(h.plainFrame()).toContain('out-row-4');
  });
});
