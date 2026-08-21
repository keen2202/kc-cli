/**
 * Permission confirmation queue — concurrent tool calls must not overwrite one
 * another in the UI. Requests are displayed FIFO and resolved one at a time,
 * so a later `ask` can never hide an earlier one and leave its executor
 * Promise pending forever.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('permission confirmation queue (behavior)', () => {
  it('shows and resolves concurrent permission requests FIFO', async () => {
    h = await renderApp({ width: 100, height: 30 });
    const first = h.engine.requestPermission({ toolName: 'Bash', inputSummary: 'first command' });
    const second = h.engine.requestPermission({ toolName: 'Bash', inputSummary: 'second command' });

    // Only the first request is visible; the second is waiting in the queue.
    await h.waitForText('first command');
    expect(h.plainFrame()).toContain('first command');
    expect(h.plainFrame()).not.toContain('second command');

    // Enter allows the visible request and advances the queue.
    await h.press(KEYS.enter);
    await expect(first).resolves.toBe('allow');
    await h.waitForText('second command');
    expect(h.plainFrame()).not.toContain('first command');

    // ESC denies the next queued request and clears the confirmation UI.
    await h.press(KEYS.escape);
    await expect(second).resolves.toBe('deny');
    await h.waitFor(() => !h!.plainFrame().includes('second command'), 3000, 'permission strip to close');
  });

  it('denies every queued request when the UI unmounts', async () => {
    h = await renderApp({ width: 100, height: 30 });
    const first = h.engine.requestPermission({ toolName: 'Bash', inputSummary: 'first command' });
    const second = h.engine.requestPermission({ toolName: 'Bash', inputSummary: 'second command' });
    await h.waitForText('first command');

    // The visible request is denied by the focus layer's dispose fallback;
    // the hidden queued request is denied by the handler cleanup.
    h.unmount();

    await expect(first).resolves.toBe('deny');
    await expect(second).resolves.toBe('deny');
  });
});
