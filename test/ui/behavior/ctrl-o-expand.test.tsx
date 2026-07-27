/**
 * Ctrl+O expand/collapse behavior (problem 4 fix).
 *
 * Through the real AppRoot tree: Ctrl+O must toggle BOTH the thinking chain
 * (previously permanently folded — chain.folded was always true and
 * renderThinkingChain had no expanded override) and the tool output cards.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

const THINKING_TEXT = 'Deep reasoning about the parser internals before answering';
const TOOL_OUTPUT = 'line-one\nline-two\nline-three-hidden\nline-four-hidden';

async function renderCompletedTurn(): Promise<Harness> {
  const engine = new FakeQueryEngine();
  engine.scriptEvents([
    { type: 'thinking_delta', thinking: THINKING_TEXT },
    { type: 'tool_started', toolCall: { toolName: 'Read', input: { file_path: 'a.ts' } } },
    { type: 'tool_completed', toolCall: { toolName: 'Read' }, result: { output: TOOL_OUTPUT }, isError: false },
    { type: 'text_delta', text: 'Here is the answer.' },
    { type: 'turn_complete' },
  ]);
  const harness = await renderApp({ width: 100, height: 40, engine });

  await harness.type('explain');
  await harness.press(KEYS.enter);
  await harness.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
  await harness.waitForText('○ idle', 5000);
  return harness;
}

describe('Ctrl+O expand/collapse (behavior)', () => {
  it('expands the thinking chain that is folded after the turn completes', async () => {
    h = await renderCompletedTurn();

    // Folded default: header only, reasoning content hidden.
    expect(h.plainFrame()).toContain('Thinking (');
    expect(h.plainFrame()).not.toContain('parser internals');

    await h.press(KEYS.ctrlO);
    await h.waitForText('parser internals', 5000);

    // Toggle back: reasoning folds again.
    await h.press(KEYS.ctrlO);
    await h.waitFor(
      () => !h!.plainFrame().includes('parser internals'),
      5000,
      'thinking chain to fold',
    );
    expect(h.plainFrame()).toContain('Thinking (');
  });

  it('expands tool output beyond the collapsed preview with the same toggle', async () => {
    h = await renderCompletedTurn();

    // Collapsed: 2-line preview, deeper lines hidden behind the expand hint.
    expect(h.plainFrame()).toContain('line-one');
    expect(h.plainFrame()).not.toContain('line-three-hidden');

    await h.press(KEYS.ctrlO);
    await h.waitForText('line-three-hidden', 5000);
    expect(h.plainFrame()).toContain('line-four-hidden');

    await h.press(KEYS.ctrlO);
    await h.waitFor(
      () => !h!.plainFrame().includes('line-three-hidden'),
      5000,
      'tool output to collapse',
    );
  });
});
