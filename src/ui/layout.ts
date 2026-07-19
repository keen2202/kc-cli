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

/**
 * Truncate `text` to fit within `width` columns, appending an ellipsis when
 * clipped. Widths <= 0 yield an empty string; a width of 1 yields the ellipsis.
 * Used by the single-row HeaderBar/StatusBar so they never wrap on narrow
 * terminals (which would break the fixed HEADER_HEIGHT/STATUS_BAR_HEIGHT).
 */
export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width === 1) return '…';
  return text.slice(0, width - 1) + '…';
}

/**
 * Abbreviate a verbose model identifier for compact display, e.g.
 * `claude-3-5-sonnet-20241022` -> `c3.5-sonnet`, `gpt-4o-mini` -> `gpt-4o-mini`.
 * Falls back to the original name when no known pattern matches.
 */
export function abbreviateModel(name: string): string {
  if (!name) return name;
  // Claude: claude-<major>-<minor>-<variant>-<date> -> c<major>.<minor>-<variant>
  const claude = name.match(/^claude-(\d+)-(\d+)-([a-z]+)/i);
  if (claude) {
    return `c${claude[1]}.${claude[2]}-${claude[3]}`;
  }
  // Strip trailing date stamps (e.g. -20241022) from any other model name.
  return name.replace(/-\d{6,8}$/, '');
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
  /** Active breakpoint name so consumers can degrade UI density. */
  breakpoint: BreakpointName;
  /** Active density derived from the breakpoint. */
  density: Density;
}

export interface LayoutOptions {
  /** When true, reserve vertical space for the error banner above the editor. */
  errorVisible?: boolean;
}

// Right panel: narrower on the standard breakpoint (80-119 cols) so the chat
// column keeps more room, wider on the wide breakpoint (>=120 cols).
const RIGHT_PANEL_WIDTH = 24;
const RIGHT_PANEL_WIDTH_WIDE = 40;
const SESSION_INFO_HEIGHT = 8;
const EDITOR_MIN_HEIGHT = 3;
const EDITOR_MAX_HEIGHT = 15;
const HEADER_HEIGHT = 1;
const STATUS_BAR_HEIGHT = 1;
// Error banner: border (2) + content (1) + marginBottom (1)
const ERROR_BAR_HEIGHT = 4;
// Minimum chat rows to keep visible; the editor is shrunk (below its nominal
// minimum if necessary) before the chat content is squeezed on short terminals.
const MIN_CONTENT_HEIGHT = 6;

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
  const rightPanelWidth = sidebarVisible
    ? (bp.name === 'wide' ? RIGHT_PANEL_WIDTH_WIDE : RIGHT_PANEL_WIDTH)
    : 0;
  const errorBarHeight = options.errorVisible ? ERROR_BAR_HEIGHT : 0;

  // Vertical space available for the main content row (between header and status bar).
  const available = Math.max(0, height - headerHeight - statusBarHeight);
  const usable = Math.max(0, available - errorBarHeight);

  // Editor grows with the terminal but is capped. To protect a minimum chat
  // area, the editor is shrunk (even below EDITOR_MIN_HEIGHT) so the content
  // keeps at least MIN_CONTENT_HEIGHT rows whenever the terminal is tall enough.
  let editorHeight = Math.max(
    EDITOR_MIN_HEIGHT,
    Math.min(EDITOR_MAX_HEIGHT, Math.floor(available * 0.25)),
  );
  editorHeight = Math.min(editorHeight, Math.max(1, usable - MIN_CONTENT_HEIGHT));
  editorHeight = Math.max(1, Math.min(editorHeight, Math.max(1, usable - 1)));

  // Chat content fills the remainder of the left column. SessionInfo is NOT
  // subtracted here: it lives in the right column, and subtracting it left ~8
  // blank rows at the bottom and floated the editor off the terminal floor.
  const contentHeight = Math.max(1, usable - editorHeight);

  // The right column spans the same height as the main content row. SessionInfo
  // shrinks so it never exceeds that row height on short terminals.
  const rowHeight = contentHeight + editorHeight + errorBarHeight;
  const sessionInfoHeight = sidebarVisible
    ? Math.min(SESSION_INFO_HEIGHT, Math.max(0, rowHeight - 1))
    : 0;

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
    breakpoint: bp.name,
    density: bp.density,
  };
}

