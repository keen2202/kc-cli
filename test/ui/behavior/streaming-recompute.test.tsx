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
import { statusBarRenderStats } from '../../../src/ui/components/StatusBarView';

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

  it('streaming tail flushes do not re-flatten history', async () => {
    const engine = new FakeQueryEngine();

    // Turn 1 completes and becomes history.
    engine.scriptEvents([
      { type: 'text_delta', text: 'first answer' },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });
    await h.type('one');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'first turn to complete');
    await h.waitForText('first answer');
    // Let the post-turn flush settle before snapshotting.
    await new Promise((resolve) => setTimeout(resolve, 150));

    const flattensBefore = chatViewRenderStats.historyFlattenCount;

    // Turn 2: the user append grows history exactly once; the streamed tail
    // only mutates the newest message. Each delta flush used to hand ChatView
    // a fresh messages array identity and re-wrap the ENTIRE transcript.
    engine.scriptEvents([
      { type: 'text_delta', text: ' working still' },
      { type: 'text_delta', text: ' more tail' },
      { type: 'turn_complete' },
    ]);
    await h.type('two');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 2, 5000, 'second turn to complete');
    await h.waitForText('more tail');

    expect(chatViewRenderStats.historyFlattenCount).toBe(flattensBefore + 1);
  });

  it('thinking delta flushes do not re-flatten chat history', async () => {
    const engine = new FakeQueryEngine();

    // Turn 1 completes and becomes history.
    engine.scriptEvents([{ type: 'text_delta', text: 'first answer' }]);
    h = await renderApp({ width: 100, height: 30, engine });
    await h.type('one');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'first turn to complete');
    await h.waitForText('first answer');

    // Turn 2 streams reasoning deltas while held open. Every coalesced flush
    // used to hand ChatView a fresh thinkingChains Map identity, invalidating
    // the history-rows memo despite the history itself being frozen.
    engine.scriptEvents([
      { type: 'text_delta', text: 'working on it' },
      { type: 'thinking_delta', thinking: 'Analyzing the first part' },
      { type: 'thinking_delta', thinking: 'Analyzing the second part' },
      { type: 'thinking_delta', thinking: 'Analyzing the third part' },
    ]);
    engine.holdNextTurn();
    await h.type('two');
    await h.press(KEYS.enter);
    // The live chain must actually render while streaming (thinking progress
    // visible), proving the fix keeps behavior, not just the counter.
    await h.waitForText('Thinking', 5000);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const flattensBefore = chatViewRenderStats.historyFlattenCount;

    // Wait out several more flush windows: the held turn keeps the streaming
    // state live, and its delta flushes previously re-flattened history.
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(chatViewRenderStats.historyFlattenCount).toBe(flattensBefore);
    expect(h.plainFrame()).toContain('Thinking');
    expect(h.plainFrame()).toContain('first answer');

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 2, 5000, 'second turn to complete');
  });

  it('streaming delta flushes do not re-render the memoized status bar', async () => {
    const engine = new FakeQueryEngine();

    engine.scriptEvents([{ type: 'text_delta', text: 'first answer' }]);
    h = await renderApp({ width: 100, height: 30, engine });
    await h.type('one');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'first turn to complete');
    await h.waitForText('first answer');
    // Let the turn-boundary renders (mode + token changes) settle.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const rendersBefore = statusBarRenderStats.renderCount;

    // A held turn streams deltas; StatusBar props (mode/provider/model/turn
    // counters/tokens) stay constant throughout, so its memo must skip the
    // per-flush app-tree re-renders.
    engine.scriptEvents([
      { type: 'text_delta', text: ' streaming tail one' },
      { type: 'text_delta', text: ' streaming tail two' },
      { type: 'text_delta', text: ' streaming tail three' },
    ]);
    engine.holdNextTurn();
    await h.type('two');
    await h.press(KEYS.enter);
    await h.waitForText('streaming tail three', 5000);
    await new Promise((resolve) => setTimeout(resolve, 250));

    // Submit/turn transitions re-render the bar; delta flushes must not.
    expect(statusBarRenderStats.renderCount).toBeLessThanOrEqual(rendersBefore + 4);

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 2, 5000, 'second turn to complete');
  });
});
