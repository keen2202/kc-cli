/**
 * Sidebar overflow characterization (T0) — floods the sidebar with far more
 * tool entries than the terminal can show and asserts the rendered frame
 * never grows taller than the terminal (the right column must truncate, not
 * push the layout apart).
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.0.1.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

function toolEvents(count: number): Array<Record<string, unknown> & { type: string }> {
  const events: Array<Record<string, unknown> & { type: string }> = [];
  for (let i = 0; i < count; i++) {
    events.push({ type: 'tool_started', toolCall: { toolName: `tool_${i}` } });
    events.push({ type: 'tool_completed', result: { output: 'ok' }, isError: false });
  }
  events.push({ type: 'turn_complete' });
  return events;
}

describe('sidebar overflow (characterization)', () => {
  it('60 tool entries never push the frame beyond a 120x40 terminal', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents(toolEvents(60));
    h = await renderApp({ width: 120, height: 40, engine });

    await h.type('run the tools');
    await h.press(KEYS.enter);
    // NOTE: characterization — the sidebar overflows, so its "Tools (N)"
    // header can be pushed out of the viewport. Gate on the engine finishing
    // the turn and the UI returning to idle instead.
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('○ idle', 5000);

    const lines = h.lines();
    expect(lines.length).toBeLessThanOrEqual(40);
    // The layout skeleton survives: editor prompt and status bar still visible.
    const frame = h.plainFrame();
    expect(frame).toContain('kc>');
    expect(frame).toContain('idle');
  });

  it('overflow data on a short terminal (80x15) does not break the height budget', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents(toolEvents(30));
    h = await renderApp({ width: 80, height: 15, engine });

    await h.type('go');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('○ idle', 5000);

    const lines = h.lines();
    expect(lines.length).toBeLessThanOrEqual(15);
  });
});
