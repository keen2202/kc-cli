import { describe, it, expect, vi } from 'vitest';
import { OverlayManager } from '../../src/ui/overlay-manager';
import type { Overlay, RenderResult } from '../../src/ui/overlay-manager';
import type { KeypressEvent } from '../../src/ui/keypress';
import { getTheme } from '../../src/ui/theme';

function createMockOverlay(id: string, zIndex: number, onKeypress?: (key: KeypressEvent) => boolean): Overlay {
  return {
    id,
    zIndex,
    render: (_w: number, _h: number, _theme: any): RenderResult => ({
      lines: [`overlay:${id}`],
    }),
    onKeypress: onKeypress || (() => false),
  };
}

describe('OverlayManager', () => {
  it('should push and check overlays', () => {
    const mgr = new OverlayManager();
    expect(mgr.isEmpty()).toBe(true);

    mgr.push(createMockOverlay('a', 1));
    expect(mgr.has('a')).toBe(true);
    expect(mgr.isEmpty()).toBe(false);
  });

  it('should pop overlays in LIFO order', () => {
    const mgr = new OverlayManager();
    mgr.push(createMockOverlay('a', 1));
    mgr.push(createMockOverlay('b', 2));

    const popped = mgr.pop();
    expect(popped?.id).toBe('b');
    expect(mgr.has('b')).toBe(false);
    expect(mgr.has('a')).toBe(true);
  });

  it('should remove overlay by id', () => {
    const mgr = new OverlayManager();
    mgr.push(createMockOverlay('a', 1));
    mgr.push(createMockOverlay('b', 2));

    mgr.remove('a');
    expect(mgr.has('a')).toBe(false);
    expect(mgr.has('b')).toBe(true);
  });

  it('should call onClose when popping', () => {
    const onClose = vi.fn();
    const overlay: Overlay = {
      id: 'test',
      zIndex: 1,
      render: () => ({ lines: [] }),
      onKeypress: () => false,
      onClose,
    };

    const mgr = new OverlayManager();
    mgr.push(overlay);
    mgr.pop();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('should dispatch keypresses top-down (highest zIndex first)', () => {
    const mgr = new OverlayManager();
    const order: string[] = [];

    mgr.push(createMockOverlay('low', 1, () => { order.push('low'); return false; }));
    mgr.push(createMockOverlay('mid', 5, () => { order.push('mid'); return false; }));
    mgr.push(createMockOverlay('high', 10, () => { order.push('high'); return false; }));

    mgr.handleKeypress({ name: 'up', ctrl: false, meta: false });
    expect(order).toEqual(['high', 'mid', 'low']);
  });

  it('should stop at first overlay that consumes the keypress', () => {
    const mgr = new OverlayManager();

    mgr.push(createMockOverlay('low', 1, () => false));
    mgr.push(createMockOverlay('high', 10, () => true)); // consumes

    const handler = vi.fn();
    mgr.push({
      id: 'listener',
      zIndex: 5,
      render: () => ({ lines: [] }),
      onKeypress: handler,
    });

    const consumed = mgr.handleKeypress({ name: 'up', ctrl: false, meta: false });
    expect(consumed).toBe(true);
    // 'listener' has lower zIndex than 'high', so it shouldn't be called
    expect(handler).not.toHaveBeenCalled();
  });

  it('should render all overlays', () => {
    const mgr = new OverlayManager();
    const theme = getTheme('dark');

    mgr.push(createMockOverlay('a', 1));
    mgr.push(createMockOverlay('b', 2));

    const output = mgr.render(80, 24, theme);
    expect(output).toContain('overlay:a');
    expect(output).toContain('overlay:b');
  });

  it('should return empty string when no overlays', () => {
    const mgr = new OverlayManager();
    const theme = getTheme('dark');
    expect(mgr.render(80, 24, theme)).toBe('');
  });

  it('should replace overlay with same id', () => {
    const mgr = new OverlayManager();
    mgr.push(createMockOverlay('a', 1));
    mgr.push(createMockOverlay('a', 5)); // replaces

    expect(mgr.get('a')?.zIndex).toBe(5);
  });
});
