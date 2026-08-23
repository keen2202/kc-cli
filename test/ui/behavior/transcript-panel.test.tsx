/**
 * T25 phase 1 — TranscriptPanel extraction (chat/messages slot).
 *
 * Renders the REAL AppRoot through the behavior harness and asserts
 * user-visible transcript behavior, so moving the ChatPanel wiring into
 * src/ui/panels/TranscriptPanel.tsx cannot change rendered output:
 * empty-state placeholder, role markers + ordering, and tool cards living
 * inside the transcript below the reply marker.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('TranscriptPanel (behavior)', () => {
  it('shows the empty-state placeholder before any message exists', async () => {
    h = await renderApp({ width: 100, height: 30 });
    expect(h.plainFrame()).toContain('No messages yet. Start a conversation.');
  });

  it('renders user + assistant turns with distinct markers in order', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'text_delta', text: 'Transcript panel reply.' },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('transcript probe');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('Transcript panel reply.', 5000);

    const frame = h.plainFrame();
    expect(frame).toContain('▌ You');
    expect(frame).toContain('transcript probe');
    expect(frame).toContain('● kc');
    expect(frame).toContain('Transcript panel reply.');
    // The question marker must appear above the reply marker (question first).
    expect(frame.indexOf('▌ You')).toBeLessThan(frame.indexOf('● kc'));
  });

  it('keeps completed tool cards inside the transcript below the reply marker', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'tool_started', toolCall: { toolName: 'Grep', input: { pattern: 'x' } } },
      { type: 'tool_completed', toolCall: { toolName: 'Grep' }, result: { output: 'hit-1' }, isError: false },
      { type: 'text_delta', text: 'done' },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('find things');
    await h.press(KEYS.enter);
    await h.waitForText('✓ Grep', 5000);

    const lines = h.lines();
    const markerLine = lines.findIndex((l) => l.includes('● kc'));
    const toolLine = lines.findIndex((l) => l.includes('✓ Grep'));
    expect(markerLine).toBeGreaterThanOrEqual(0);
    // The tool card sits below the reply marker and is indented (body gutter).
    expect(toolLine).toBeGreaterThan(markerLine);
    expect(lines[toolLine]!.startsWith('  ')).toBe(true);
  });
});
