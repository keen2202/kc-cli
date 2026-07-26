/**
 * FocusStack pure-logic unit tests (T1) — top-layer exclusivity, unified ESC
 * routing, layer-by-layer pop, idempotent unregister, and guaranteed dispose.
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.1.1.
 */

import { describe, it, expect, vi } from 'vitest';
import { FocusStack, type FocusLayer, type FocusLayerId } from '../../src/ui/focus-stack';
import type { KeypressEvent } from '../../src/ui/keypress';

const key = (name: string, extra: Partial<KeypressEvent> = {}): KeypressEvent => ({
  name,
  ctrl: false,
  meta: false,
  ...extra,
});

const ESC = key('escape');

/** Build a layer with spies; onKey/onEscape return values are configurable. */
function makeLayer(
  id: FocusLayerId,
  opts: { consumes?: boolean; escapes?: boolean } = {},
): FocusLayer & { onKey: ReturnType<typeof vi.fn>; onEscape: ReturnType<typeof vi.fn>; onDispose: ReturnType<typeof vi.fn> } {
  return {
    id,
    onKey: vi.fn(() => opts.consumes ?? true),
    onEscape: vi.fn(() => opts.escapes ?? true),
    onDispose: vi.fn(),
  };
}

describe('FocusStack', () => {
  it('empty stack: handleKey is a no-op, top/snapshot are empty', () => {
    const stack = new FocusStack();
    expect(stack.handleKey(key('a'))).toBe(false);
    expect(stack.top()).toBeNull();
    expect(stack.snapshot()).toEqual([]);
  });

  it('push order defines the top; snapshot lists bottom-to-top', () => {
    const stack = new FocusStack();
    stack.push(makeLayer('editor'));
    stack.push(makeLayer('permission'));
    stack.push(makeLayer('diff-detail'));
    expect(stack.top()).toBe('diff-detail');
    expect(stack.snapshot()).toEqual(['editor', 'permission', 'diff-detail']);
  });

  describe('top-layer exclusivity', () => {
    it('only the top layer receives keys', () => {
      const stack = new FocusStack();
      const base = makeLayer('editor');
      const top = makeLayer('palette');
      stack.push(base);
      stack.push(top);

      expect(stack.handleKey(key('a'))).toBe(true);
      expect(top.onKey).toHaveBeenCalledTimes(1);
      expect(base.onKey).not.toHaveBeenCalled();
    });

    it('keys never fall through even when the top layer does not consume them', () => {
      const stack = new FocusStack();
      const base = makeLayer('editor');
      const top = makeLayer('permission', { consumes: false });
      stack.push(base);
      stack.push(top);

      expect(stack.handleKey(key('x'))).toBe(false);
      expect(base.onKey).not.toHaveBeenCalled();
    });
  });

  describe('unified ESC routing', () => {
    it('ESC invokes only the top layer onEscape (never onKey, never lower layers)', () => {
      const stack = new FocusStack();
      const base = makeLayer('editor');
      const top = makeLayer('palette');
      stack.push(base);
      stack.push(top);

      expect(stack.handleKey(ESC)).toBe(true);
      expect(top.onEscape).toHaveBeenCalledTimes(1);
      expect(top.onKey).not.toHaveBeenCalled();
      expect(base.onEscape).not.toHaveBeenCalled();
    });

    it('a false onEscape (editor base) is NOT forwarded downward', () => {
      const stack = new FocusStack();
      const below = makeLayer('error');
      const top = makeLayer('editor', { escapes: false });
      stack.push(below);
      stack.push(top);

      expect(stack.handleKey(ESC)).toBe(false);
      expect(below.onEscape).not.toHaveBeenCalled();
    });

    it('Ctrl/Meta+escape is not ESC semantics — routed to onKey', () => {
      const stack = new FocusStack();
      const top = makeLayer('palette');
      stack.push(top);

      stack.handleKey(key('escape', { ctrl: true }));
      expect(top.onEscape).not.toHaveBeenCalled();
      expect(top.onKey).toHaveBeenCalledTimes(1);
    });

    it('ESC pops layer by layer when each onEscape unregisters its own layer', () => {
      const stack = new FocusStack();
      const order: string[] = [];

      const pushSelfPopping = (id: FocusLayerId) => {
        const layer: FocusLayer = {
          id,
          onKey: () => true,
          onEscape: () => {
            order.push(id);
            unregister();
            return true;
          },
        };
        const unregister = stack.push(layer);
        return unregister;
      };

      pushSelfPopping('permission');
      pushSelfPopping('diff-detail');

      stack.handleKey(ESC); // pops diff-detail first (stack order guarantee)
      expect(stack.top()).toBe('permission');
      stack.handleKey(ESC);
      expect(stack.top()).toBeNull();
      expect(order).toEqual(['diff-detail', 'permission']);
    });
  });

  describe('unregister & dispose guarantees', () => {
    it('unregister removes the layer and fires onDispose exactly once (idempotent)', () => {
      const stack = new FocusStack();
      const layer = makeLayer('permission');
      const unregister = stack.push(layer);

      unregister();
      unregister();
      unregister();

      expect(stack.snapshot()).toEqual([]);
      expect(layer.onDispose).toHaveBeenCalledTimes(1);
    });

    it('removing a mid-stack layer keeps the rest intact', () => {
      const stack = new FocusStack();
      const a = makeLayer('editor');
      const b = makeLayer('goal');
      const c = makeLayer('palette');
      stack.push(a);
      const unregisterB = stack.push(b);
      stack.push(c);

      unregisterB();

      expect(stack.snapshot()).toEqual(['editor', 'palette']);
      expect(b.onDispose).toHaveBeenCalledTimes(1);
      expect(stack.top()).toBe('palette');
    });

    it('dispose reaches promise-style layers so pending decisions always resolve', async () => {
      const stack = new FocusStack();
      let decision: Promise<string> | null = null;
      let resolveDecision: ((d: string) => void) | null = null;
      decision = new Promise<string>((resolve) => {
        resolveDecision = resolve;
      });

      const unregister = stack.push({
        id: 'permission',
        onKey: () => true,
        onEscape: () => true,
        // The permission layer's safety net: deny on forced removal.
        onDispose: () => resolveDecision?.('deny'),
      });

      unregister(); // host component force-unmounted
      await expect(decision).resolves.toBe('deny');
    });
  });

  describe('subscribe', () => {
    it('notifies on push and unregister; unsubscribe stops notifications', () => {
      const stack = new FocusStack();
      const listener = vi.fn();
      const unsubscribe = stack.subscribe(listener);

      const unregister = stack.push(makeLayer('palette'));
      expect(listener).toHaveBeenCalledTimes(1);

      unregister();
      expect(listener).toHaveBeenCalledTimes(2);

      unsubscribe();
      stack.push(makeLayer('editor'));
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });
});
