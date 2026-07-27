/**
 * Multi-internal-turn streaming (problem 2 fix, UI side).
 *
 * QueryEngine emits turn_complete after every internal turn of one user
 * query. Previously useStreamingEvents cleared currentAssistantIdRef on the
 * first turn_complete, so all text from subsequent internal turns of the same
 * query was silently dropped — the UI looked like the agent "stopped
 * responding" mid-query. Now a fresh assistant bubble opens for the extra
 * output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('multi-turn stream (behavior)', () => {
  it('renders text from internal turns after the first turn_complete', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'text_delta', text: 'first-turn-output' },
      { type: 'turn_complete' },
      // Second internal turn of the SAME query — previously dropped.
      { type: 'text_delta', text: 'second-turn-output' },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('do the thing');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');

    await h.waitForText('first-turn-output', 5000);
    await h.waitForText('second-turn-output', 5000);
  });
});
