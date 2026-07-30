/**
 * Permission detail expansion (problem 4 fix): a tool request that carries no
 * file diff (e.g. a shell command) can still be expanded with Ctrl+O to reveal
 * the full, untruncated operation detail before the user authorizes it. The
 * inline confirm strip advertises the affordance, and ESC unwinds the stacked
 * detail layer before denying — consistent with the focus-stack ESC contract.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

// A command longer than the inline summary cap so we can prove the expanded
// dialog shows it untruncated.
const LONG_COMMAND =
  'grep -rn "TODO" src tests docs --include="*.ts" --exclude-dir=node_modules';

describe('permission detail expansion (behavior)', () => {
  it('advertises Ctrl+O details even without a diff', async () => {
    h = await renderApp({ width: 100, height: 30 });
    void h.engine.requestPermission({
      toolName: 'Bash',
      inputSummary: 'run a shell command',
      details: `Command:\n${LONG_COMMAND}`,
    });
    await h.waitForText('Bash', 5000);
    // Confirm strip offers the expand affordance for a diff-less request.
    expect(h.plainFrame()).toContain('Ctrl+O');
    expect(h.plainFrame()).toContain('Details');
  });

  it('Ctrl+O reveals the full command; ESC closes the detail then denies', async () => {
    h = await renderApp({ width: 100, height: 30 });
    const decision = h.engine.requestPermission({
      toolName: 'Bash',
      inputSummary: 'run a shell command',
      details: `Command:\n${LONG_COMMAND}`,
    });
    await h.waitForText('Bash', 5000);
    // The inline strip only shows the short summary, not the full command.
    expect(h.plainFrame()).not.toContain(LONG_COMMAND);

    // Expand: the detail dialog shows the complete, untruncated command.
    await h.press(KEYS.ctrlO);
    await h.waitForText('Permission Required', 3000);
    expect(h.plainFrame()).toContain(LONG_COMMAND);

    // ESC #1 pops only the detail layer; the request stays pending.
    await h.press(KEYS.escape);
    await h.waitFor(() => !h!.plainFrame().includes('Permission Required'), 3000, 'detail to close');
    expect(h.plainFrame()).toContain('Bash'); // confirm strip still up

    // ESC #2 denies via the permission layer beneath.
    await h.press(KEYS.escape);
    await expect(decision).resolves.toBe('deny');
  });
});
