/**
 * Refresh stability (problem 3 fix): the rendered frame must stay strictly
 * below the terminal height. When ink's output reaches the full terminal
 * height it abandons incremental diffing and does clearTerminal + full
 * repaint on every frame — the visible flicker users reported. Layout caps
 * the frame at height-1 to keep the smooth diff renderer active.
 *
 * Also covers the nowTick sink: the per-second session clock now lives inside
 * SessionInfo (self-ticking) instead of re-rendering the whole app tree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

const SIZES: Array<[number, number]> = [
  [80, 24],
  [120, 40],
  [60, 20],
];

describe('refresh stability (behavior)', () => {
  it.each(SIZES)('frame stays below the full terminal height at %ix%i', async (width, height) => {
    h = await renderApp({ width, height });
    await h.waitForText('kc>');

    // Strictly below the terminal height: at exactly `height` rows ink would
    // switch to the flickering clearTerminal + full-repaint path.
    expect(h.lines().length).toBeLessThanOrEqual(height - 1);
  });

  it('session duration clock renders from the self-ticking SessionInfo panel', async () => {
    // Wide enough for the sidebar breakpoint so Session Info is visible.
    h = await renderApp({ width: 120, height: 40 });
    await h.waitForText('Session Info');
    expect(h.plainFrame()).toContain('Duration:');
  });

  it('frame stays below full height while a tool streams (no repaint flicker)', async () => {
    // A held turn keeps the running tool card ticking its live elapsed. Because
    // that clock is scoped to ChatView (not a whole-tree `now` state), the
    // frame must stay strictly below the terminal height across the tick window
    // — the invariant that keeps ink on its smooth incremental-diff path.
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'text_delta', text: 'working on it' },
      { type: 'tool_started', toolCall: { toolName: 'Bash', input: { command: 'sleep 1' } } },
    ]);
    engine.holdNextTurn();
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('go');
    await h.press(KEYS.enter);
    await h.waitForText('Bash', 5000);
    expect(h.lines().length).toBeLessThanOrEqual(30 - 1);

    // Wait past a 1s tick, then re-check: the running clock must not have grown
    // the frame to full height.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(h.lines().length).toBeLessThanOrEqual(30 - 1);
    expect(h.plainFrame()).toContain('running');

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
  });
});
