import { describe, it, expect, beforeEach } from 'vitest';
import { LayoutManager } from '../../src/ui/layout';

describe('LayoutManager', () => {
  let layout: LayoutManager;

  beforeEach(() => {
    layout = new LayoutManager();
    layout.updateTerminalSize(120, 40);
  });

  describe('mode management', () => {
    it('should default to sidebar-main mode', () => {
      expect(layout.getMode()).toBe('sidebar-main');
    });

    it('should switch to main-only mode', () => {
      layout.setMode('main-only');
      expect(layout.getMode()).toBe('main-only');
      expect(layout.isPanelVisible('sidebar')).toBe(false);
      expect(layout.isPanelVisible('main')).toBe(true);
    });

    it('should switch to main-bottom mode', () => {
      layout.setMode('main-bottom');
      expect(layout.isPanelVisible('bottom')).toBe(true);
      expect(layout.isPanelVisible('sidebar')).toBe(false);
    });

    it('should switch to three-column mode', () => {
      layout.setMode('three-column');
      expect(layout.isPanelVisible('sidebar')).toBe(true);
      expect(layout.isPanelVisible('right')).toBe(true);
      expect(layout.isPanelVisible('main')).toBe(true);
    });

    it('should cycle through modes', () => {
      expect(layout.cycleMode()).toBe('main-only');
      expect(layout.cycleMode()).toBe('main-bottom');
      expect(layout.cycleMode()).toBe('three-column');
      expect(layout.cycleMode()).toBe('sidebar-main');
    });
  });

  describe('panel visibility', () => {
    it('should toggle panel visibility', () => {
      expect(layout.isPanelVisible('sidebar')).toBe(true);
      layout.togglePanel('sidebar');
      expect(layout.isPanelVisible('sidebar')).toBe(false);
      layout.togglePanel('sidebar');
      expect(layout.isPanelVisible('sidebar')).toBe(true);
    });

    it('should set panel visibility explicitly', () => {
      layout.setPanelVisible('sidebar', false);
      expect(layout.isPanelVisible('sidebar')).toBe(false);
    });

    it('should return false for unknown panels', () => {
      expect(layout.isPanelVisible('unknown')).toBe(false);
    });
  });

  describe('panel resizing', () => {
    it('should resize sidebar wider', () => {
      layout.resizePanel('sidebar', 10);
      const dims = layout.calculateDimensions();
      const sidebar = dims.panels.get('sidebar');
      expect(sidebar?.width).toBe(40); // 30 + 10
    });

    it('should resize sidebar narrower', () => {
      layout.resizePanel('sidebar', -5);
      const dims = layout.calculateDimensions();
      const sidebar = dims.panels.get('sidebar');
      expect(sidebar?.width).toBe(25); // 30 - 5
    });

    it('should respect minimum width', () => {
      layout.resizePanel('sidebar', -100);
      const dims = layout.calculateDimensions();
      const sidebar = dims.panels.get('sidebar');
      expect(sidebar?.width).toBe(20); // minWidth
    });

    it('should respect maximum width', () => {
      layout.resizePanel('sidebar', 100);
      const dims = layout.calculateDimensions();
      const sidebar = dims.panels.get('sidebar');
      expect(sidebar?.width).toBe(50); // maxWidth
    });

    it('should not resize auto-width panels', () => {
      const before = layout.calculateDimensions();
      const mainBefore = before.panels.get('main')?.width;
      layout.resizePanel('main', 10);
      const after = layout.calculateDimensions();
      const mainAfter = after.panels.get('main')?.width;
      expect(mainAfter).toBe(mainBefore); // unchanged
    });
  });

  describe('dimension calculation', () => {
    it('should calculate sidebar-main layout', () => {
      const dims = layout.calculateDimensions();
      const sidebar = dims.panels.get('sidebar');
      const main = dims.panels.get('main');

      expect(sidebar).toBeDefined();
      expect(main).toBeDefined();
      expect(sidebar!.x).toBe(0);
      expect(main!.x).toBe(sidebar!.width);
      expect(sidebar!.width + main!.width).toBe(120);
    });

    it('should auto-fold sidebar on narrow terminals', () => {
      layout.updateTerminalSize(60, 24);
      const dims = layout.calculateDimensions();
      const sidebar = dims.panels.get('sidebar');
      const main = dims.panels.get('main');

      expect(sidebar).toBeUndefined(); // folded
      expect(main).toBeDefined();
      expect(main!.x).toBe(0);
    });

    it('should handle main-bottom layout', () => {
      layout.setMode('main-bottom');
      const dims = layout.calculateDimensions();
      const main = dims.panels.get('main');
      const bottom = dims.panels.get('bottom');

      expect(main).toBeDefined();
      expect(bottom).toBeDefined();
      expect(bottom!.y).toBeGreaterThan(0);
      expect(bottom!.width).toBe(120); // full width
    });

    it('should handle three-column layout', () => {
      layout.setMode('three-column');
      const dims = layout.calculateDimensions();
      const sidebar = dims.panels.get('sidebar');
      const main = dims.panels.get('main');
      const right = dims.panels.get('right');

      expect(sidebar).toBeDefined();
      expect(main).toBeDefined();
      expect(right).toBeDefined();
      expect(sidebar!.x).toBe(0);
      expect(main!.x).toBe(sidebar!.width);
      expect(right!.x).toBe(sidebar!.width + main!.width);
    });
  });

  describe('terminal size', () => {
    it('should update terminal size', () => {
      layout.updateTerminalSize(160, 50);
      const dims = layout.calculateDimensions();
      expect(dims.terminalWidth).toBe(160);
      expect(dims.terminalHeight).toBe(50);
    });
  });
});
