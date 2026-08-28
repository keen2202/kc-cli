/**
 * Tool lifecycle + live status behavior (silent-failure & stuck-status fixes).
 *
 * Covers:
 * 1. Status bar reflects the real engine phase: `executing` while a tool is
 *    running (previously it showed a static `streaming` for the whole turn).
 * 2. agent:tool_failed finalizes the tool card as failed with a coded,
 *    actionable message (previously the event was dropped and the card was
 *    stuck at `running` forever).
 * 3. A stream `error` event surfaces a `[code] … Suggestion: …` message in
 *    the error bar and returns the status bar to idle (no stuck streaming).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('tool lifecycle + live status (behavior)', () => {
  it('shows executing in the status bar while a tool is running', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'text_delta', text: 'let me check' },
      {
        type: 'agent:tool_started',
        toolCall: { id: 't1', toolName: 'Bash', input: { command: 'echo hi' } },
        timestamp: Date.now(),
      },
    ]);
    engine.holdNextTurn(); // keep the turn open so the mid-turn state is observable
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('run it');
    await h.press(KEYS.enter);

    // Status bar must refine 'streaming' into 'executing' while the tool runs,
    // and the chat area must show the live running tool card.
    await h.waitForText('executing', 5000);
    await h.waitForText('Bash', 5000);
    expect(h.plainFrame()).toContain('running');

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('○ idle', 5000);
  });

  it('finalizes the tool card as failed on agent:tool_failed', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'text_delta', text: 'trying a tool' },
      {
        type: 'agent:tool_started',
        toolCall: { id: 't1', toolName: 'Bash', input: { command: 'find . -name x' } },
        timestamp: Date.now(),
      },
      {
        type: 'agent:tool_failed',
        toolCall: { id: 't1', toolName: 'Bash', input: { command: 'find . -name x' } },
        error: new Error('boom failure'),
        timestamp: Date.now(),
      },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('do it');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');

    // The card must leave the running state and surface the failure with an
    // error code and suggestion (previously tool_failed was silently dropped).
    await h.waitForText('✗', 5000);
    const frame = h.plainFrame();
    expect(frame).toContain('boom failure');
    expect(frame).toContain('[unknown]');
    expect(frame).not.toContain('(running');
    // Status bar back to idle after the turn.
    await h.waitForText('○ idle', 5000);
  });

  it('surfaces a coded error and recovers input after a stream error event', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'error', error: new Error('fetch failed ECONNREFUSED 127.0.0.1:443') },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('hello');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');

    // Error bar shows the classified code (the full message carries the
    // actionable suggestion; the one-row bar may truncate its tail).
    await h.waitForText('[api_server_error]', 5000);
    await h.waitForText('ECONNREFUSED', 5000);

    // isStreaming must be cleared: the editor accepts a second message.
    await h.type('second message');
    await h.waitForText('second message', 5000);
  });

  it('finalizes parallel same-name tool calls by id, not by name', async () => {
    // Two same-named tools start together; B completes while A is still
    // running. Name-based matching would close A's card with B's output.
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      {
        type: 'agent:tool_started',
        toolCall: { id: 'a1', toolName: 'Grep', input: { pattern: 'alpha' } },
        timestamp: Date.now(),
      },
      {
        type: 'agent:tool_started',
        toolCall: { id: 'b2', toolName: 'Grep', input: { pattern: 'beta' } },
        timestamp: Date.now(),
      },
      {
        type: 'agent:tool_completed',
        toolCall: { id: 'b2', toolName: 'Grep' },
        result: { output: 'beta-result' },
        isError: false,
        timestamp: Date.now(),
      },
    ]);
    engine.holdNextTurn(); // keep A in flight while the mid-turn state is observed
    h = await renderApp({ width: 100, height: 40, engine });

    await h.type('go');
    await h.press(KEYS.enter);
    await h.waitForText('beta-result', 5000);

    const frame = h.plainFrame();
    // B's card completed with ITS output…
    expect(frame).toContain('beta-result');
    // …while A's card is still the only running one (still alive, no output).
    expect(frame).toContain('running');
    expect(frame).not.toContain('alpha-result');

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
  });
});
