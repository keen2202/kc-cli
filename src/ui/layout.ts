// Multi-panel layout management for terminal UI
// Supports configurable layout modes, panel resizing, and responsive behavior.

export type LayoutMode = 'sidebar-main' | 'main-only' | 'main-bottom' | 'three-column';

export type Density = 'compact' | 'normal' | 'wide';

export interface LayoutBreakpoint {
  name: 'tiny' | 'compact' | 'standard' | 'wide';
  minCols: number;
  density: Density;
  sidebarVisible: boolean;
  headerVisible: boolean;
}

export const BREAKPOINTS: LayoutBreakpoint[] = [
  { name: 'tiny', minCols: 0, density: 'compact', sidebarVisible: false, headerVisible: false },
  { name: 'compact', minCols: 60, density: 'compact', sidebarVisible: false, headerVisible: true },
  { name: 'standard', minCols: 80, density: 'normal', sidebarVisible: true, headerVisible: true },
  { name: 'wide', minCols: 120, density: 'wide', sidebarVisible: true, headerVisible: true },
];

export function getBreakpoint(cols: number): LayoutBreakpoint {
  for (let i = BREAKPOINTS.length - 1; i >= 0; i--) {
    if (cols >= BREAKPOINTS[i]!.minCols) return BREAKPOINTS[i]!;
  }
  return BREAKPOINTS[0]!;
}

export interface PanelConfig {
  id: string;
  width: number | 'auto';
  minWidth: number;
  maxWidth: number;
  visible: boolean;
  position: 'left' | 'right' | 'center' | 'bottom';
}

export interface LayoutDimensions {
  panels: Map<string, { x: number; y: number; width: number; height: number }>;
  terminalWidth: number;
  terminalHeight: number;
}

interface LayoutPanel {
  id: string;
  config: PanelConfig;
  width: number; // Computed actual width
}

const DEFAULT_PANEL_CONFIGS: Record<string, PanelConfig> = {
  sidebar: {
    id: 'sidebar',
    width: 30,
    minWidth: 20,
    maxWidth: 50,
    visible: true,
    position: 'left',
  },
  main: {
    id: 'main',
    width: 'auto',
    minWidth: 40,
    maxWidth: 999,
    visible: true,
    position: 'center',
  },
  bottom: {
    id: 'bottom',
    width: 'auto',
    minWidth: 40,
    maxWidth: 999,
    visible: false,
    position: 'bottom',
  },
  right: {
    id: 'right',
    width: 30,
    minWidth: 20,
    maxWidth: 50,
    visible: false,
    position: 'right',
  },
};

export class LayoutManager {
  private mode: LayoutMode = 'sidebar-main';
  private panels: Map<string, LayoutPanel> = new Map();
  private terminalWidth = 80;
  private terminalHeight = 24;

  constructor() {
    // Initialize panels from defaults
    for (const [id, config] of Object.entries(DEFAULT_PANEL_CONFIGS)) {
      this.panels.set(id, { id, config: { ...config }, width: 0 });
    }
    this.applyMode();
  }

  /**
   * Get the current layout mode.
   */
  getMode(): LayoutMode {
    return this.mode;
  }

  /**
   * Switch layout mode.
   */
  setMode(mode: LayoutMode): void {
    this.mode = mode;
    this.applyMode();
  }

  /**
   * Cycle to the next layout mode.
   */
  cycleMode(): LayoutMode {
    const modes: LayoutMode[] = ['sidebar-main', 'main-only', 'main-bottom', 'three-column'];
    const idx = modes.indexOf(this.mode);
    this.setMode(modes[(idx + 1) % modes.length]);
    return this.mode;
  }

  /**
   * Resize a panel by a delta (positive = wider, negative = narrower).
   */
  resizePanel(id: string, delta: number): void {
    const panel = this.panels.get(id);
    if (!panel || panel.config.width === 'auto') return;

    const newWidth = Math.max(
      panel.config.minWidth,
      Math.min(panel.config.maxWidth, (panel.config.width as number) + delta)
    );
    panel.config.width = newWidth;
    this.recalculate();
  }

  /**
   * Toggle panel visibility.
   */
  togglePanel(id: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    panel.config.visible = !panel.config.visible;
    this.recalculate();
  }

  /**
   * Set panel visibility explicitly.
   */
  setPanelVisible(id: string, visible: boolean): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    panel.config.visible = visible;
    this.recalculate();
  }

  /**
   * Check if a panel is visible.
   */
  isPanelVisible(id: string): boolean {
    return this.panels.get(id)?.config.visible ?? false;
  }

  /**
   * Update terminal dimensions and recalculate layout.
   */
  updateTerminalSize(width: number, height: number): void {
    this.terminalWidth = width;
    this.terminalHeight = height;
    this.recalculate();
  }

  /**
   * Calculate and return the current layout dimensions.
   */
  calculateDimensions(): LayoutDimensions {
    this.recalculate();
    const panels = new Map<string, { x: number; y: number; width: number; height: number }>();

    let x = 0;
    const visiblePanels = this.getVisiblePanels();

    // Auto-detect responsive: fold sidebar if terminal < 80 columns
    const effectivePanels = this.terminalWidth < 80
      ? visiblePanels.filter(p => p.id !== 'sidebar')
      : visiblePanels;

    for (const panel of effectivePanels) {
      if (panel.config.position === 'bottom') {
        // Bottom panel spans full width, placed at bottom
        const bottomHeight = Math.min(10, Math.floor(this.terminalHeight / 3));
        panels.set(panel.id, {
          x: 0,
          y: this.terminalHeight - bottomHeight,
          width: this.terminalWidth,
          height: bottomHeight,
        });
      } else {
        panels.set(panel.id, {
          x,
          y: 0,
          width: panel.width,
          height: this.terminalHeight,
        });
        x += panel.width;
      }
    }

    return {
      panels,
      terminalWidth: this.terminalWidth,
      terminalHeight: this.terminalHeight,
    };
  }

  /**
   * Get panel info for the mouse handler (resize handles, etc.).
   */
  getPanelRegions(): Array<{ id: string; x: number; y: number; width: number; height: number }> {
    const dims = this.calculateDimensions();
    return Array.from(dims.panels.entries()).map(([id, rect]) => ({
      id,
      ...rect,
    }));
  }

  /**
   * Apply the current layout mode to panel visibility/width.
   */
  private applyMode(): void {
    const sidebar = this.panels.get('sidebar');
    const main = this.panels.get('main');
    const bottom = this.panels.get('bottom');
    const right = this.panels.get('right');

    if (!sidebar || !main || !bottom || !right) return;

    switch (this.mode) {
      case 'sidebar-main':
        sidebar.config.visible = true;
        main.config.visible = true;
        bottom.config.visible = false;
        right.config.visible = false;
        break;
      case 'main-only':
        sidebar.config.visible = false;
        main.config.visible = true;
        bottom.config.visible = false;
        right.config.visible = false;
        break;
      case 'main-bottom':
        sidebar.config.visible = false;
        main.config.visible = true;
        bottom.config.visible = true;
        right.config.visible = false;
        break;
      case 'three-column':
        sidebar.config.visible = true;
        main.config.visible = true;
        bottom.config.visible = false;
        right.config.visible = true;
        break;
    }

    this.recalculate();
  }

  /**
   * Get visible panels in positional order (left → center → right → bottom).
   */
  private getVisiblePanels(): LayoutPanel[] {
    const order = ['left', 'center', 'right', 'bottom'];
    return Array.from(this.panels.values())
      .filter(p => p.config.visible)
      .sort((a, b) => order.indexOf(a.config.position) - order.indexOf(b.config.position));
  }

  /**
   * Recalculate panel widths based on terminal size and panel configs.
   */
  private recalculate(): void {
    const visiblePanels = this.getVisiblePanels();

    // Responsive: fold sidebar on narrow terminals
    const effectivePanels = this.terminalWidth < 80
      ? visiblePanels.filter(p => p.id !== 'sidebar')
      : visiblePanels;

    let fixedWidth = 0;
    let autoCount = 0;

    // First pass: assign fixed widths
    for (const panel of effectivePanels) {
      if (panel.config.position === 'bottom') continue; // bottom is full-width
      if (panel.config.width === 'auto') {
        autoCount++;
      } else {
        panel.width = panel.config.width as number;
        fixedWidth += panel.width;
      }
    }

    // Second pass: distribute remaining width to auto panels
    const remaining = Math.max(0, this.terminalWidth - fixedWidth);
    const autoWidth = autoCount > 0 ? Math.floor(remaining / autoCount) : 0;

    for (const panel of effectivePanels) {
      if (panel.config.width === 'auto') {
        panel.width = Math.max(panel.config.minWidth, autoWidth);
      }
    }
  }
}
