/**
 * Runtime hardening behavior matrix (T1–T6, ui-runtime-hardening).
 *
 * End-to-end assertions through the real AppRoot tree:
 *  - T1: turn_complete usage reaches the status bar token counter.
 *  - T2: thinking deltas are visible live while the turn is still streaming.
 *  - T3: sidebar tool entries carry lifecycle state, duration and detail.
 *  - T4: any open overlay flips the status bar mode to "overlay".
 *  - T6: long input on a narrow terminal never breaks the height/width budget.
 *
 * Spec: docs/specs/ui-runtime-hardening-spec.md.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('runtime hardening (behavior)', () => {
  it('T2: thinking deltas render a live preview while streaming', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'thinking_delta', thinking: 'Analyzing the request in detail' },
    ]);
    engine.holdNextTurn(); // keep the turn streaming so we observe the live state
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('why');
    await h.press(KEYS.enter);

    // The thinking chain must be visible DURING the stream, not only after
    // turn_complete (previously it was only stored on turn completion).
    await h.waitForText('Thinking (', 5000);
    expect(h.plainFrame()).toContain('Analyzing the request');

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
  });

  it('T1: turn_complete usage feeds the status bar token counter', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      {
        type: 'turn_complete',
        usage: { inputTokens: 1000, outputTokens: 234, totalTokens: 1234 },
      },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('count');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');

    await h.waitForText('1234 tokens', 5000);
  });

  it('T3: sidebar tool entry shows completion, duration and input detail', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'tool_started', toolCall: { toolName: 'Read', input: { file_path: 'a.ts' } } },
      { type: 'tool_completed', toolCall: { toolName: 'Read' }, result: { output: 'ok' }, isError: false },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 120, height: 40, engine });

    await h.type('read the file');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('○ idle', 5000);

    const frame = h.plainFrame();
    // Lifecycle: the entry is closed out as completed (✓), not stuck running.
    expect(frame).toContain('✓ Read');
    // Detail: the summarized tool input is rendered next to the name.
    expect(frame).toContain('a.ts');
    // Duration: a `N.Ns` timing is attached on completion.
    expect(frame).toMatch(/\d+\.\ds/);
  });

  it('T4: an open overlay flips the status bar mode to "overlay"', async () => {
    h = await renderApp({ width: 80, height: 24 });

    await h.press(KEYS.ctrlK);
    await h.waitForText('Command Palette');
    await h.waitForText('overlay');

    await h.press(KEYS.escape);
    await h.waitFor(() => !h!.plainFrame().includes('Command Palette'), 3000, 'palette to close');
    await h.waitForText('○ idle');
  });

  it('T6: long input on a 60x20 terminal stays inside the frame budget', async () => {
    h = await renderApp({ width: 60, height: 20 });

    const longText =
      'this is a very long single line of input text that easily exceeds sixty columns of terminal width';
    await h.type(longText);

    const lines = h.lines();
    // Height budget: the frame never grows taller than the terminal.
    expect(lines.length).toBeLessThanOrEqual(20);
    // Width budget: no rendered line spills past the terminal width.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
    // The layout skeleton survives: prompt and status bar are still visible.
    const frame = h.plainFrame();
    expect(frame).toContain('kc>');
    expect(frame).toContain('idle');
  });
});
