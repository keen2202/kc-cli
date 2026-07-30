/**
 * Chat message layout (problem 3 fix): a submitted question must carry a clear
 * "▌ You" marker, the assistant reply a distinct "● kc" marker, and the two
 * turns must be visually separable. Rendered through the real AppRoot tree so
 * the assertion is on user-visible output, not layout arithmetic.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('chat message layout (behavior)', () => {
  it('marks the user question and the assistant reply with distinct role markers', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'text_delta', text: 'Here is the answer to your question.' },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('what is the capital of France');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('Here is the answer', 5000);

    const frame = h.plainFrame();
    // Clear question marker + the question text.
    expect(frame).toContain('▌ You');
    expect(frame).toContain('what is the capital of France');
    // Distinct reply marker + the reply text.
    expect(frame).toContain('● kc');
    expect(frame).toContain('Here is the answer');
    // The question marker must appear above the reply marker (question first).
    expect(frame.indexOf('▌ You')).toBeLessThan(frame.indexOf('● kc'));
  });

  it('indents the assistant tool card under the reply marker (aligned body)', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([
      { type: 'tool_started', toolCall: { toolName: 'Bash', input: { command: 'ls' } } },
      { type: 'tool_completed', toolCall: { toolName: 'Bash' }, result: { output: 'file-a' }, isError: false },
      { type: 'turn_complete' },
    ]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('list files');
    await h.press(KEYS.enter);
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
    await h.waitForText('✓ Bash', 5000);

    const lines = h.lines();
    const markerLine = lines.findIndex((l) => l.includes('● kc'));
    const toolLine = lines.findIndex((l) => l.includes('✓ Bash'));
    expect(markerLine).toBeGreaterThanOrEqual(0);
    // The tool card sits below the reply marker and is indented (body gutter).
    expect(toolLine).toBeGreaterThan(markerLine);
    expect(lines[toolLine]!.startsWith('  ')).toBe(true);
  });
});
