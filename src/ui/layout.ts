// OpenCode-style layout calculation for the terminal UI

export type BreakpointName = 'tiny' | 'compact' | 'standard' | 'wide';
export type Density = 'compact' | 'normal' | 'wide';

export interface Breakpoint {
  name: BreakpointName;
  minCols: number;
  density: Density;
  sidebarVisible: boolean;
  headerVisible: boolean;
}

export const BREAKPOINTS: Breakpoint[] = [
  { name: 'tiny', minCols: 0, density: 'compact', sidebarVisible: false, headerVisible: false },
  { name: 'compact', minCols: 60, density: 'compact', sidebarVisible: false, headerVisible: true },
  { name: 'standard', minCols: 80, density: 'normal', sidebarVisible: true, headerVisible: true },
  { name: 'wide', minCols: 120, density: 'wide', sidebarVisible: true, headerVisible: true },
];

export function getBreakpoint(cols: number): Breakpoint {
  for (let i = BREAKPOINTS.length - 1; i >= 0; i--) {
    if (cols >= BREAKPOINTS[i]!.minCols) return BREAKPOINTS[i]!;
  }
  return BREAKPOINTS[0]!;
}

export interface OpenCodeLayout {
  terminalWidth: number;
  terminalHeight: number;
  headerHeight: number;
  rightPanelWidth: number;
  sessionInfoHeight: number;
  editorHeight: number;
  statusBarHeight: number;
  sidebarVisible: boolean;
  headerVisible: boolean;
  contentHeight: number;
}

const RIGHT_PANEL_WIDTH = 30;
const SESSION_INFO_HEIGHT = 8;
const EDITOR_MIN_HEIGHT = 3;
const EDITOR_MAX_HEIGHT = 15;
const HEADER_HEIGHT = 1;
const STATUS_BAR_HEIGHT = 1;

/**
 * Compute the opencode-style layout for the given terminal dimensions.
 */
export function computeOpenCodeLayout(width: number, height: number): OpenCodeLayout {
  const bp = getBreakpoint(width);
  const headerVisible = bp.headerVisible;
  const sidebarVisible = bp.sidebarVisible;
  const headerHeight = headerVisible ? HEADER_HEIGHT : 0;
  const statusBarHeight = STATUS_BAR_HEIGHT;
  const rightPanelWidth = sidebarVisible ? RIGHT_PANEL_WIDTH : 0;
  const sessionInfoHeight = sidebarVisible ? SESSION_INFO_HEIGHT : 0;

  // Editor grows with terminal but is capped
  const available = height - headerHeight - statusBarHeight;
  const editorHeight = Math.max(
    EDITOR_MIN_HEIGHT,
    Math.min(EDITOR_MAX_HEIGHT, Math.floor(available * 0.25)),
  );

  const contentHeight = available - editorHeight;

  return {
    terminalWidth: width,
    terminalHeight: height,
    headerHeight,
    rightPanelWidth,
    sessionInfoHeight,
    editorHeight,
    statusBarHeight,
    sidebarVisible,
    headerVisible,
    contentHeight,
  };
}

// ── Backward-compatible LayoutManager (delegates to new functions) ──

export type LayoutMode = 'sidebar-main' | 'main-only' | 'main-bottom' | 'three-column';

export interface PanelConfig {
  id: string;
  width: number | 'auto';
  minWidth: number;
  maxWidth: number;
  visible: boolean;
  position: 'left' | 'right' | 'center' | 'bottom';
}

interface LegacyLayoutPanel {
  id: string;
  config: PanelConfig;
  width: number;
}

const DEFAULT_PANEL_CONFIGS: Record<string, PanelConfig> = {
  sidebar: { id: 'sidebar', width: 30, minWidth: 20, maxWidth: 50, visible: true, position: 'left' },
  main: { id: 'main', width: 'auto', minWidth: 40, maxWidth: 999, visible: true, position: 'center' },
  bottom: { id: 'bottom', width: 'auto', minWidth: 40, maxWidth: 999, visible: false, position: 'bottom' },
  right: { id: 'right', width: 30, minWidth: 20, maxWidth: 50, visible: false, position: 'right' },
};

export interface LayoutDimensions {
  panels: Map<string, { x: number; y: number; width: number; height: number }>;
  terminalWidth: number;
  terminalHeight: number;
}

export class LayoutManager {
  private mode: LayoutMode = 'sidebar-main';
  private panels: Map<string, LegacyLayoutPanel> = new Map();
  private terminalWidth = 80;
  private terminalHeight = 24;

  constructor() {
    for (const [id, config] of Object.entries(DEFAULT_PANEL_CONFIGS)) {
      this.panels.set(id, { id, config: { ...config }, width: 0 });
    }
    this.applyMode();
  }

  getMode(): LayoutMode { return this.mode; }
  setMode(mode: LayoutMode): void { this.mode = mode; this.applyMode(); }

  cycleMode(): LayoutMode {
    const modes: LayoutMode[] = ['sidebar-main', 'main-only', 'main-bottom', 'three-column'];
    const idx = modes.indexOf(this.mode);
    this.setMode(modes[(idx + 1) % modes.length]);
    return this.mode;
  }

  resizePanel(id: string, delta: number): void {
    const panel = this.panels.get(id);
    if (!panel || panel.config.width === 'auto') return;
    const newWidth = Math.max(panel.config.minWidth, Math.min(panel.config.maxWidth, (panel.config.width as number) + delta));
    panel.config.width = newWidth;
    this.recalculate();
  }

  togglePanel(id: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    panel.config.visible = !panel.config.visible;
    this.recalculate();
  }

  setPanelVisible(id: string, visible: boolean): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    panel.config.visible = visible;
    this.recalculate();
  }

  isPanelVisible(id: string): boolean {
    return this.panels.get(id)?.config.visible ?? false;
  }

  updateTerminalSize(width: number, height: number): void {
    this.terminalWidth = width;
    this.terminalHeight = height;
    this.recalculate();
  }

  calculateDimensions(): LayoutDimensions {
    this.recalculate();
    const panels = new Map<string, { x: number; y: number; width: number; height: number }>();
    let x = 0;
    const visiblePanels = this.getVisiblePanels();
    const effectivePanels = this.terminalWidth < 80
      ? visiblePanels.filter(p => p.id !== 'sidebar')
      : visiblePanels;

    for (const panel of effectivePanels) {
      if (panel.config.position === 'bottom') {
        const bottomHeight = Math.min(10, Math.floor(this.terminalHeight / 3));
        panels.set(panel.id, { x: 0, y: this.terminalHeight - bottomHeight, width: this.terminalWidth, height: bottomHeight });
      } else {
        panels.set(panel.id, { x, y: 0, width: panel.width, height: this.terminalHeight });
        x += panel.width;
      }
    }

    return { panels, terminalWidth: this.terminalWidth, terminalHeight: this.terminalHeight };
  }

  getPanelRegions(): Array<{ id: string; x: number; y: number; width: number; height: number }> {
    const dims = this.calculateDimensions();
    return Array.from(dims.panels.entries()).map(([id, rect]) => ({ id, ...rect }));
  }

  private applyMode(): void {
    const sidebar = this.panels.get('sidebar');
    const main = this.panels.get('main');
    const bottom = this.panels.get('bottom');
    const right = this.panels.get('right');
    if (!sidebar || !main || !bottom || !right) return;

    switch (this.mode) {
      case 'sidebar-main':
        sidebar.config.visible = true; main.config.visible = true;
        bottom.config.visible = false; right.config.visible = false; break;
      case 'main-only':
        sidebar.config.visible = false; main.config.visible = true;
        bottom.config.visible = false; right.config.visible = false; break;
      case 'main-bottom':
        sidebar.config.visible = false; main.config.visible = true;
        bottom.config.visible = true; right.config.visible = false; break;
      case 'three-column':
        sidebar.config.visible = true; main.config.visible = true;
        bottom.config.visible = false; right.config.visible = true; break;
    }
    this.recalculate();
  }

  private getVisiblePanels(): LegacyLayoutPanel[] {
    const order = ['left', 'center', 'right', 'bottom'];
    return Array.from(this.panels.values())
      .filter(p => p.config.visible)
      .sort((a, b) => order.indexOf(a.config.position) - order.indexOf(b.config.position));
  }

  private recalculate(): void {
    const visiblePanels = this.getVisiblePanels();
    const effectivePanels = this.terminalWidth < 80
      ? visiblePanels.filter(p => p.id !== 'sidebar')
      : visiblePanels;

    let fixedWidth = 0;
    let autoCount = 0;

    for (const panel of effectivePanels) {
      if (panel.config.position === 'bottom') continue;
      if (panel.config.width === 'auto') { autoCount++; } else {
        panel.width = panel.config.width as number;
        fixedWidth += panel.width;
      }
    }

    const remaining = Math.max(0, this.terminalWidth - fixedWidth);
    const autoWidth = autoCount > 0 ? Math.floor(remaining / autoCount) : 0;

    for (const panel of effectivePanels) {
      if (panel.config.width === 'auto') {
        panel.width = Math.max(panel.config.minWidth, autoWidth);
      }
    }
  }
}
