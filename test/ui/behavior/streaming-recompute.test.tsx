/**
 * Streaming recompute guard (perf): the 1s streaming clock tick must NOT
 * re-flatten chat history. Only the newest (streaming) message may re-render
 * with the live `now` — history rows stay cached across ticks. Regression
 * guard for the O(N)-per-second full re-flatten that made long transcripts
 * increasingly expensive while a turn streamed.
 *
 * Probe: chatViewRenderStats.historyFlattenCount increments every time the
 * history flatten memo re-executes inside ChatView.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';
import { chatViewRenderStats } from '../../../src/ui/components/ChatMessagesView';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('streaming recompute guard (behavior)', () => {
  it('the streaming clock tick does not re-flatten chat history', async () => {
    const engine = new FakeQueryEngine();

    // Turn 1 completes and becomes history.
    engine.scriptEvents([{ type: 'text_delta', text: 'first answer' }]);
    h = await renderApp({ width: 100, height: 30, engine });
    await h.type('one');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'first turn to complete');
    await h.waitForText('first answer');

    // Turn 2 is held streaming with a running tool card (live clock active).
    engine.scriptEvents([
      { type: 'text_delta', text: 'working on it' },
      { type: 'tool_started', toolCall: { toolName: 'Bash', input: { command: 'sleep 1' } } },
    ]);
    engine.holdNextTurn();
    await h.type('two');
    await h.press(KEYS.enter);
    await h.waitForText('Bash', 5000);

    // Let renders triggered by the submit itself settle, then snapshot.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const flattensBefore = chatViewRenderStats.historyFlattenCount;

    // Cross at least one full 1s tick window while streaming.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // History must not have been re-flattened by the clock tick…
    expect(chatViewRenderStats.historyFlattenCount).toBe(flattensBefore);
    // …while the live tool card keeps ticking on the newest message.
    expect(h.plainFrame()).toContain('running');
    expect(h.plainFrame()).toContain('first answer');

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 2, 5000, 'second turn to complete');
  });
});
