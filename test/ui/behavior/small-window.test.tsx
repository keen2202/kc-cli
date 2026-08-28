/**
 * Small-window compatibility (behavior) — the frame must survive short and
 * narrow terminals WITH overlays open. In-flow overlays (command palette,
 * file picker, permission dialog) used to render at natural height, pushing
 * the frame past the terminal (ink's clearTerminal full-repaint flicker path,
 * overlays running off-screen). The layout policy now budgets their rows;
 * these tests lock the user-visible invariants:
 *   1. the frame never exceeds the terminal height,
 *   2. the status bar stays visible on screen (not clipped away),
 *   3. the overlay stays usable (title/hint/buttons within the frame).
 *
 * Note: the overlay slot renders AFTER the status bar in the column, so while
 * an overlay is open the status bar is intentionally NOT the last row — the
 * invariant is that it remains visible somewhere in the frame.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('small-window overlays (behavior)', () => {
  it('keeps the frame intact with the command palette open on a short terminal', async () => {
    h = await renderApp({ width: 80, height: 14 });

    await h.press(KEYS.ctrlK);
    await h.waitForText('Command Palette', 5000);

    const lines = h.lines();
    expect(lines.length).toBeLessThanOrEqual(14);
    // Status bar still on screen (it shows the overlay mode while open).
    expect(h.plainFrame()).toContain('test-provider/test-model');
    // Palette stays usable: title and the bottom navigation hint visible.
    expect(h.plainFrame()).toContain('Command Palette');
    expect(h.plainFrame()).toContain('Esc: close');

    // ESC closes it again.
    await h.press(KEYS.escape);
    await h.waitFor(() => !h!.plainFrame().includes('Command Palette'), 5000, 'palette to close');
  });

  it('shows the full palette item list at comfortable sizes (no regression)', async () => {
    h = await renderApp({ width: 100, height: 30 });

    await h.press(KEYS.ctrlK);
    await h.waitForText('Command Palette', 5000);
    // /help and /clear both fit within the default 10-item window.
    await h.waitForText('/help', 5000);
    await h.waitForText('/clear', 5000);
    expect(h.lines().length).toBeLessThanOrEqual(30);
  });

  it('keeps the frame intact with the expanded permission dialog on a short terminal', async () => {
    const engine = new FakeQueryEngine();
    h = await renderApp({ width: 100, height: 16, engine });

    void h.engine.requestPermission({
      toolName: 'Bash',
      inputSummary: 'run a shell command',
      details: Array.from({ length: 24 }, (_, i) => `detail line ${i + 1}`).join('\n'),
    });
    await h.waitForText('Bash', 5000);

    // Expand into the diff-detail dialog (Ctrl+O), clamped to the row budget.
    await h.press(KEYS.ctrlO);
    await h.waitForText('Permission Required', 5000);

    const lines = h.lines();
    expect(lines.length).toBeLessThanOrEqual(16);
    expect(h.plainFrame()).toContain('test-provider/test-model');
    // Core dialog affordances survive the clamp: the buttons row and the
    // first detail line; deeper lines are windowed away.
    expect(h.plainFrame()).toContain('[Y]');
    expect(h.plainFrame()).toContain('detail line 1');
  });

  it('keeps the frame intact with the file picker open on a narrow terminal', async () => {
    h = await renderApp({ width: 48, height: 20 });

    await h.press('\u0006'); // Ctrl+F opens the file picker
    await h.waitForText('File Picker', 5000);

    const lines = h.lines();
    // Narrow terminal: the picker clamps to the width budget, so the sidebar/
    // chat column cannot push it out of the frame.
    expect(lines.length).toBeLessThanOrEqual(20);
    // Status bar still on screen — at tiny widths it degrades to the compact
    // form (mode + turn counter), so assert the counter, not the model name.
    expect(h.plainFrame()).toContain('0/50');
    // The picker's own chrome renders (title + windowed list; the hint text
    // may wrap across lines at this width).
    expect(h.plainFrame()).toContain('File Picker');
    expect(h.plainFrame()).toContain('… 27 more');
  });
});
