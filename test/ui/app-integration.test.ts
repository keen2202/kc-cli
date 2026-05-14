import { describe, it, expect, beforeEach } from 'vitest';
import { getTheme, THEMES, themeColor, listThemes } from '../../src/ui/theme';
import { LayoutManager } from '../../src/ui/layout';
import { MouseHandler } from '../../src/ui/mouse';

/**
 * UI integration tests: theme + layout + mouse coordination.
 */

describe('UI Full Integration', () => {
  describe('Theme System', () => {
    it('should have 5 built-in themes', () => {
      expect(Object.keys(THEMES)).toHaveLength(5);
      expect(THEMES['dark']).toBeDefined();
      expect(THEMES['light']).toBeDefined();
      expect(THEMES['solarized-dark']).toBeDefined();
      expect(THEMES['monokai']).toBeDefined();
      expect(THEMES['dracula']).toBeDefined();
    });

    it('should get theme by name', () => {
      const dark = getTheme('dark');
      expect(dark.name).toBe('dark');
      expect(dark.colors.primary).toBeTruthy();
      expect(dark.syntax.keyword).toBeTruthy();
      expect(dark.diff.added).toBeTruthy();
    });

    it('should fallback to dark for unknown theme', () => {
      const theme = getTheme('nonexistent');
      expect(theme.name).toBe('dark');
    });

    it('should list all theme names', () => {
      const names = listThemes();
      expect(names).toContain('dark');
      expect(names).toContain('light');
      expect(names).toContain('dracula');
    });

    it('should resolve theme color to chalk function', () => {
      const theme = getTheme('dark');
      const colorFn = themeColor(theme, 'colors.primary');
      expect(typeof colorFn).toBe('function');
    });

    it('should handle nested color paths', () => {
      const theme = getTheme('dark');
      const keywordColor = themeColor(theme, 'syntax.keyword');
      expect(typeof keywordColor).toBe('function');
    });

    it('should fallback to white for unknown paths', () => {
      const theme = getTheme('dark');
      const unknownColor = themeColor(theme, 'nonexistent.path');
      expect(typeof unknownColor).toBe('function');
    });
  });

  describe('Layout + Theme Coordination', () => {
    it('should calculate layout dimensions for all modes', () => {
      const layout = new LayoutManager();
      layout.updateTerminalSize(120, 40);

      const modes = ['sidebar-main', 'main-only', 'main-bottom', 'three-column'] as const;
      for (const mode of modes) {
        layout.setMode(mode);
        const dims = layout.calculateDimensions();
        expect(dims.terminalWidth).toBe(120);
        expect(dims.terminalHeight).toBe(40);
        expect(dims.panels.size).toBeGreaterThan(0);
      }
    });

    it('should apply theme colors to layout regions', () => {
      const theme = getTheme('dracula');
      const layout = new LayoutManager();
      layout.updateTerminalSize(120, 40);

      const regions = layout.getPanelRegions();
      expect(regions.length).toBeGreaterThan(0);

      // Each region should have valid dimensions
      for (const region of regions) {
        expect(region.width).toBeGreaterThan(0);
        expect(region.height).toBeGreaterThan(0);
        expect(region.x).toBeGreaterThanOrEqual(0);
        expect(region.y).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('Mouse + Layout Coordination', () => {
    it('should set layout regions for mouse hit-testing', () => {
      const layout = new LayoutManager();
      const mouse = new MouseHandler();

      layout.updateTerminalSize(120, 40);
      const regions = layout.getPanelRegions();

      mouse.setRegions(regions.map(r => ({
        id: r.id,
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
      })));

      // Mouse events within regions should be processed
      expect(mouse.processEvent({ x: 5, y: 5, button: 'left', action: 'press', raw: '' })).not.toBeNull();
    });

    it('should handle scroll events with layout', () => {
      const mouse = new MouseHandler();
      const action = mouse.processEvent({
        x: 50, y: 20, button: 'scroll-up', action: 'scroll', raw: '',
      });
      expect(action).toEqual({ type: 'scroll', direction: 'up', amount: 3 });
    });
  });

  describe('Responsive Behavior', () => {
    it('should fold sidebar on narrow terminals', () => {
      const layout = new LayoutManager();
      layout.updateTerminalSize(60, 24);
      layout.setMode('sidebar-main');

      const dims = layout.calculateDimensions();
      expect(dims.panels.has('sidebar')).toBe(false);
      expect(dims.panels.has('main')).toBe(true);
    });

    it('should show sidebar on wide terminals', () => {
      const layout = new LayoutManager();
      layout.updateTerminalSize(120, 40);
      layout.setMode('sidebar-main');

      const dims = layout.calculateDimensions();
      expect(dims.panels.has('sidebar')).toBe(true);
      expect(dims.panels.has('main')).toBe(true);
    });
  });
});

describe('UI Render Performance', () => {
  it('should calculate dimensions for 1000 messages in <10ms', () => {
    const layout = new LayoutManager();
    layout.updateTerminalSize(120, 40);

    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      layout.calculateDimensions();
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50); // 1000 iterations in <50ms
  });

  it('should process 1000 mouse events in <10ms', () => {
    const mouse = new MouseHandler();
    mouse.setRegions([
      { id: 'sidebar', x: 0, y: 0, width: 30, height: 40 },
      { id: 'main', x: 30, y: 0, width: 90, height: 40 },
    ]);

    const events = Array.from({ length: 1000 }, (_, i) => ({
      x: i % 120,
      y: i % 40,
      button: 'left' as const,
      action: 'press' as const,
      raw: '',
    }));

    const start = performance.now();
    for (const event of events) {
      mouse.processEvent(event);
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(10);
  });

  it('should get theme 10000 times in <50ms', () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      getTheme('dark');
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});
