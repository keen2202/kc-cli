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
  errorBarHeight: number;
}

export interface LayoutOptions {
  /** When true, reserve vertical space for the error banner above the editor. */
  errorVisible?: boolean;
}

const RIGHT_PANEL_WIDTH = 30;
const SESSION_INFO_HEIGHT = 8;
const EDITOR_MIN_HEIGHT = 3;
const EDITOR_MAX_HEIGHT = 15;
const HEADER_HEIGHT = 1;
const STATUS_BAR_HEIGHT = 1;
// Error banner: border (2) + content (1) + marginBottom (1)
const ERROR_BAR_HEIGHT = 4;

/**
 * Compute the opencode-style layout for the given terminal dimensions.
 */
export function computeOpenCodeLayout(
  width: number,
  height: number,
  options: LayoutOptions = {},
): OpenCodeLayout {
  const bp = getBreakpoint(width);
  const headerVisible = bp.headerVisible;
  const sidebarVisible = bp.sidebarVisible;
  const headerHeight = headerVisible ? HEADER_HEIGHT : 0;
  const statusBarHeight = STATUS_BAR_HEIGHT;
  const rightPanelWidth = sidebarVisible ? RIGHT_PANEL_WIDTH : 0;
  const sessionInfoHeight = sidebarVisible ? SESSION_INFO_HEIGHT : 0;
  const errorBarHeight = options.errorVisible ? ERROR_BAR_HEIGHT : 0;

  // Editor grows with terminal but is capped
  const available = height - headerHeight - statusBarHeight;
  const editorHeight = Math.max(
    EDITOR_MIN_HEIGHT,
    Math.min(EDITOR_MAX_HEIGHT, Math.floor(available * 0.25)),
  );

  // Guard against negative height on short terminals (sidebar visible uses ~13 rows).
  // The error banner (when visible) also eats into the chat content area so the
  // total column height never exceeds the terminal height (avoids overlap).
  const contentHeight = Math.max(
    1,
    available - editorHeight - sessionInfoHeight - errorBarHeight,
  );

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
    errorBarHeight,
  };
}

