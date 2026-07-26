/**
 * ESC characterization matrix (T0) — locks the CURRENT Esc semantics of the
 * real component tree so the focus-stack refactor (T1/T2) can prove behavioral
 * equivalence. Five states: permission → deny, overlay → close, goal → cancel,
 * error → dismiss, idle → no side effects. Plus the key-leak baseline.
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.0.1.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

describe('ESC matrix (characterization)', () => {
  it('permission pending: ESC denies the request', async () => {
    h = await renderApp({ width: 100, height: 30 });
    const decision = h.engine.requestPermission({ toolName: 'write_file', inputSummary: 'write a.txt' });
    await h.waitForText('write_file');

    await h.press(KEYS.escape);

    await expect(decision).resolves.toBe('deny');
    // The confirm strip disappears once decided.
    await h.waitFor(() => !h!.plainFrame().includes('write_file'), 3000, 'permission strip to close');
  });

  it('overlay open: ESC closes the command palette', async () => {
    h = await renderApp({ width: 100, height: 30 });
    await h.press(KEYS.ctrlK);
    await h.waitForText('Command Palette');

    await h.press(KEYS.escape);

    await h.waitFor(() => !h!.plainFrame().includes('Command Palette'), 3000, 'palette to close');
    // Base UI is intact afterwards (editor prompt still present).
    expect(h.plainFrame()).toContain('kc>');
  });

  it('goal active: ESC requests cancellation', async () => {
    const engine = new FakeQueryEngine();
    engine.holdNextTurn(); // keep the first goal iteration streaming
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('/goal ship the feature');
    await h.press(KEYS.enter);
    await h.waitForText('[Goal mode] Working toward: ship the feature');

    await h.press(KEYS.escape);

    await h.waitForText('[Goal mode] Stopping after the current step...');
    engine.releaseGate();
    await h.waitForText('[Goal mode] Stopped by user.');
  });

  it('error bar visible: ESC dismisses the newest error', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([{ type: 'error', error: { message: 'boom-failure' } }]);
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('trigger');
    await h.press(KEYS.enter);
    await h.waitForText('Error: boom-failure');

    await h.press(KEYS.escape);

    await h.waitFor(() => !h!.plainFrame().includes('Error: boom-failure'), 3000, 'error bar to clear');
  });

  it('idle: ESC has no visible side effects', async () => {
    h = await renderApp({ width: 100, height: 30 });
    await h.waitForText('kc>');
    const before = h.plainFrame();

    await h.press(KEYS.escape);

    const after = h.plainFrame();
    expect(after).toBe(before);
  });
});

describe('key-leak baseline (characterization)', () => {
  it('printable keys do not reach the editor while a permission is pending', async () => {
    h = await renderApp({ width: 100, height: 30 });
    const decision = h.engine.requestPermission({ toolName: 'run_command', inputSummary: 'rm -rf x' });
    await h.waitForText('run_command');

    // NOTE: characterization — while pending, a/A decides allow_always and
    // Enter/Esc decide too; every OTHER printable key must be swallowed.
    // Use characters outside the decision set to probe for leaks.
    await h.type('zzxzz');

    // The editor input line must not have received the characters.
    expect(h.plainFrame()).not.toContain('zzxzz');

    await h.press(KEYS.escape);
    await expect(decision).resolves.toBe('deny');
    // After the decision, typing works again.
    await h.type('ok');
    await h.waitForText('kc> ok');
  });
});

// ── T8 extensions: full focus-stack state combinations ──
// Spec §3.4.1: multi-layer stacking, dispose fallback, rapid ESC bursts.

describe('ESC matrix — stacked layers (T8)', () => {
  it('permission + diff-detail: first ESC closes the diff, second ESC denies', async () => {
    h = await renderApp({ width: 100, height: 30 });
    const decision = h.engine.requestPermission({
      toolName: 'write_file',
      inputSummary: 'write b.txt',
      diffs: [{ filePath: 'b.txt', oldContent: null, newContent: 'hello\n' }],
    });
    await h.waitForText('write_file');

    // Ctrl+O expands the diff detail; its layer stacks above permission.
    await h.press(KEYS.ctrlO);
    await h.waitForText('Permission Required');

    // ESC #1: only the diff-detail layer pops — the request stays pending.
    await h.press(KEYS.escape);
    await h.waitFor(() => !h!.plainFrame().includes('Permission Required'), 3000, 'diff detail to close');
    expect(h.plainFrame()).toContain('write_file'); // confirm strip still up

    // ESC #2: the permission layer (now top) denies.
    await h.press(KEYS.escape);
    await expect(decision).resolves.toBe('deny');
  });

  it('goal + error: ESC cancels the goal, not the error bar', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents([{ type: 'error', error: { message: 'goal-turn-error' } }]);
    engine.holdNextTurn(); // keep the goal iteration streaming after the error
    h = await renderApp({ width: 100, height: 30, engine });

    await h.type('/goal ship it');
    await h.press(KEYS.enter);
    await h.waitForText('Error: goal-turn-error');

    await h.press(KEYS.escape);

    // Goal cancellation wins (error layer is not mounted while a goal runs);
    // the error bar is untouched.
    await h.waitForText('[Goal mode] Stopping after the current step...');
    expect(h.plainFrame()).toContain('Error: goal-turn-error');

    engine.releaseGate();
    await h.waitForText('[Goal mode] Stopped by user.');
  });

  it('dispose fallback: unmounting with a pending permission still denies', async () => {
    h = await renderApp({ width: 100, height: 30 });
    const decision = h.engine.requestPermission({ toolName: 'edit_file', inputSummary: 'edit c.txt' });
    await h.waitForText('edit_file');

    // Tear the tree down without any decision: the layer's onDispose must
    // resolve the executor Promise (deny) — never a deadlock.
    h.unmount();

    await expect(decision).resolves.toBe('deny');
  });

  it('rapid consecutive ESC: denies once, then no-ops without breaking input', async () => {
    h = await renderApp({ width: 100, height: 30 });
    const decision = h.engine.requestPermission({ toolName: 'run_command', inputSummary: 'ls' });
    await h.waitForText('run_command');

    // Burst of ESC presses: the first decides, the rest land on idle/no-op
    // layers and must neither throw nor re-resolve with anything else.
    await h.press(KEYS.escape);
    await h.press(KEYS.escape);
    await h.press(KEYS.escape);

    await expect(decision).resolves.toBe('deny');
    await h.waitFor(() => !h!.plainFrame().includes('run_command'), 3000, 'permission strip to close');

    // The editor still accepts input afterwards.
    await h.type('still-alive');
    await h.waitForText('kc> still-alive');
  });
});
