import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MouseHandler } from '../../src/ui/mouse';
import type { MouseEvent, LayoutRegion } from '../../src/ui/mouse';

describe('MouseHandler', () => {
  let handler: MouseHandler;
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    handler = new MouseHandler();
    originalWrite = process.stdout.write;
    process.stdout.write = vi.fn().mockReturnValue(true) as any;
  });

  afterEach(() => {
    handler.destroy();
    process.stdout.write = originalWrite;
  });

  describe('enable/disable', () => {
    it('should start disabled', () => {
      expect(handler.isEnabled()).toBe(false);
    });

    it('should enable mouse tracking', () => {
      handler.enable();
      expect(handler.isEnabled()).toBe(true);
      expect(process.stdout.write).toHaveBeenCalledWith('\x1b[?1000h');
      expect(process.stdout.write).toHaveBeenCalledWith('\x1b[?1002h');
      expect(process.stdout.write).toHaveBeenCalledWith('\x1b[?1006h');
    });

    it('should disable mouse tracking', () => {
      handler.enable();
      handler.disable();
      expect(handler.isEnabled()).toBe(false);
      expect(process.stdout.write).toHaveBeenCalledWith('\x1b[?1000l');
      expect(process.stdout.write).toHaveBeenCalledWith('\x1b[?1002l');
      expect(process.stdout.write).toHaveBeenCalledWith('\x1b[?1006l');
    });

    it('should not double-enable', () => {
      handler.enable();
      handler.enable();
      // enable called escape sequences only once
      const calls = (process.stdout.write as any).mock.calls.filter(
        (c: any[]) => c[0] === '\x1b[?1000h'
      );
      expect(calls).toHaveLength(1);
    });
  });

  describe('parseEvent', () => {
    it('should parse SGR mouse press event', () => {
      // SGR format: \x1b[<button;col;rowM
      const data = Buffer.from('\x1b[<0;10;5M');
      const event = handler.parseEvent(data);

      expect(event).not.toBeNull();
      expect(event!.x).toBe(9); // 0-based
      expect(event!.y).toBe(4); // 0-based
      expect(event!.button).toBe('left');
      expect(event!.action).toBe('press');
    });

    it('should parse SGR mouse release event', () => {
      const data = Buffer.from('\x1b[<0;10;5m');
      const event = handler.parseEvent(data);

      expect(event).not.toBeNull();
      expect(event!.action).toBe('release');
    });

    it('should parse scroll-up event', () => {
      const data = Buffer.from('\x1b[<64;10;5M');
      const event = handler.parseEvent(data);

      expect(event).not.toBeNull();
      expect(event!.button).toBe('scroll-up');
    });

    it('should parse scroll-down event', () => {
      const data = Buffer.from('\x1b[<65;10;5M');
      const event = handler.parseEvent(data);

      expect(event).not.toBeNull();
      expect(event!.button).toBe('scroll-down');
    });

    it('should parse right-click event', () => {
      const data = Buffer.from('\x1b[<2;10;5M');
      const event = handler.parseEvent(data);

      expect(event).not.toBeNull();
      expect(event!.button).toBe('right');
    });

    it('should return null for non-mouse data', () => {
      const data = Buffer.from('hello world');
      const event = handler.parseEvent(data);
      expect(event).toBeNull();
    });
  });

  describe('processEvent', () => {
    it('should return scroll-up action', () => {
      const event: MouseEvent = { x: 0, y: 0, button: 'scroll-up', action: 'scroll', raw: '' };
      const action = handler.processEvent(event);
      expect(action).toEqual({ type: 'scroll', direction: 'up', amount: 3 });
    });

    it('should return scroll-down action', () => {
      const event: MouseEvent = { x: 0, y: 0, button: 'scroll-down', action: 'scroll', raw: '' };
      const action = handler.processEvent(event);
      expect(action).toEqual({ type: 'scroll', direction: 'down', amount: 3 });
    });

    it('should return focus-input for click outside regions', () => {
      const event: MouseEvent = { x: 50, y: 50, button: 'left', action: 'press', raw: '' };
      const action = handler.processEvent(event);
      expect(action).toEqual({ type: 'focus-input' });
    });

    it('should hit-test sidebar tab region', () => {
      handler.setRegions([
        { id: 'sidebar-tab-tools', x: 0, y: 0, width: 10, height: 1 },
        { id: 'sidebar-tab-files', x: 0, y: 1, width: 10, height: 1 },
      ]);

      const event: MouseEvent = { x: 5, y: 1, button: 'left', action: 'press', raw: '' };
      const action = handler.processEvent(event);
      expect(action).toEqual({ type: 'sidebar-tab', tab: 'files' });
    });

    it('should hit-test message area', () => {
      handler.setRegions([
        { id: 'messages', x: 0, y: 2, width: 80, height: 20 },
      ]);

      const event: MouseEvent = { x: 10, y: 5, button: 'left', action: 'press', raw: '' };
      const action = handler.processEvent(event);
      expect(action).toEqual({ type: 'click-message', index: 3 });
    });

    it('should hit-test input area', () => {
      handler.setRegions([
        { id: 'input', x: 0, y: 22, width: 80, height: 2 },
      ]);

      const event: MouseEvent = { x: 10, y: 23, button: 'left', action: 'press', raw: '' };
      const action = handler.processEvent(event);
      expect(action).toEqual({ type: 'focus-input' });
    });

    it('should ignore non-left-click press events', () => {
      const event: MouseEvent = { x: 5, y: 5, button: 'right', action: 'press', raw: '' };
      const action = handler.processEvent(event);
      expect(action).toBeNull();
    });

    it('should ignore release events', () => {
      const event: MouseEvent = { x: 5, y: 5, button: 'left', action: 'release', raw: '' };
      const action = handler.processEvent(event);
      expect(action).toBeNull();
    });
  });

  describe('handleData', () => {
    it('should return true for mouse events', () => {
      handler.enable();
      const data = Buffer.from('\x1b[<0;10;5M');
      expect(handler.handleData(data)).toBe(true);
    });

    it('should return false for non-mouse data', () => {
      const data = Buffer.from('hello');
      expect(handler.handleData(data)).toBe(false);
    });

    it('should invoke callback with action', () => {
      const callback = vi.fn();
      handler.on(callback);
      handler.setRegions([
        { id: 'sidebar-tab-tools', x: 0, y: 0, width: 10, height: 1 },
      ]);

      const data = Buffer.from('\x1b[<0;5;1M');
      handler.handleData(data);

      expect(callback).toHaveBeenCalledWith({ type: 'sidebar-tab', tab: 'tools' });
    });
  });

  describe('destroy', () => {
    it('should clean up state', () => {
      handler.enable();
      handler.setRegions([{ id: 'test', x: 0, y: 0, width: 1, height: 1 }]);
      handler.on(() => {});

      handler.destroy();

      expect(handler.isEnabled()).toBe(false);
    });
  });
});
