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

  it('reveals the full tool input args on expand and hides them on collapse', async () => {
    const longCommand = 'run-a-very-long-command --flag value-that-exceeds-the-40-char-summary-cut';
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      {
        type: 'tool_started',
        toolCall: { id: 'tc-1', toolName: 'Bash', input: { command: longCommand, timeout: 1234 } },
      },
      {
        type: 'tool_completed',
        toolCall: { id: 'tc-1', toolName: 'Bash' },
        result: { output: 'done' },
        isError: false,
      },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 40, engine });
    await h.type('go');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('○ idle', 5000);

    // Collapsed: only the 40-char input summary survives ingestion.
    expect(h.plainFrame()).toContain('Bash');
    expect(h.plainFrame()).not.toContain('value-that-exceeds');

    await h.press(KEYS.ctrlO);
    await h.waitForText('args:', 5000);
    // The full command renders (it may wrap across terminal columns).
    expect(h.plainFrame()).toContain('timeout: 1234');
    expect(h.plainFrame()).toContain('value-that-exceeds');

    await h.press(KEYS.ctrlO);
    await h.waitFor(
      () => !h!.plainFrame().includes('args:'),
      5000,
      'args block to collapse',
    );
  });
});
