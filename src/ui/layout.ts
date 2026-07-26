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
  editorHeight: number;
  statusBarHeight: number;
  sidebarVisible: boolean;
  headerVisible: boolean;
  /** Active breakpoint name so consumers can degrade UI density. */
  breakpoint: BreakpointName;
  /** Active density derived from the breakpoint. */
  density: Density;
}

// Right panel: narrower on the standard breakpoint (80-119 cols) so the chat
// column keeps more room, wider on the wide breakpoint (>=120 cols).
const RIGHT_PANEL_WIDTH = 24;
const RIGHT_PANEL_WIDTH_WIDE = 40;
const EDITOR_MIN_HEIGHT = 3;
const EDITOR_MAX_HEIGHT = 15;
const HEADER_HEIGHT = 1;
const STATUS_BAR_HEIGHT = 1;

/**
 * Compute the layout POLICY for the given terminal dimensions: breakpoint,
 * density, panel widths and the editor's target height. All other heights are
 * measured by Yoga from the components' natural sizes (spec §3.2.1) — this
 * module deliberately knows nothing about how tall the error bar, operation
 * strip, session info or sidebar render; reverse-engineering component
 * internals into row constants is what rotted the previous layout.
 */
export function computeOpenCodeLayout(
  width: number,
  height: number,
): OpenCodeLayout {
  const bp = getBreakpoint(width);
  const headerVisible = bp.headerVisible;
  const sidebarVisible = bp.sidebarVisible;
  const headerHeight = headerVisible ? HEADER_HEIGHT : 0;
  const statusBarHeight = STATUS_BAR_HEIGHT;
  const rightPanelWidth = sidebarVisible
    ? (bp.name === 'wide' ? RIGHT_PANEL_WIDTH_WIDE : RIGHT_PANEL_WIDTH)
    : 0;

  // Editor target height: grows with the terminal, capped, and yields on very
  // short terminals so at least one chat row survives beside the two strips.
  const available = Math.max(0, height - headerHeight - statusBarHeight);
  let editorHeight = Math.max(
    EDITOR_MIN_HEIGHT,
    Math.min(EDITOR_MAX_HEIGHT, Math.floor(available * 0.25)),
  );
  editorHeight = Math.max(1, Math.min(editorHeight, Math.max(1, available - 2)));

  return {
    terminalWidth: width,
    terminalHeight: height,
    headerHeight,
    rightPanelWidth,
    editorHeight,
    statusBarHeight,
    sidebarVisible,
    headerVisible,
    breakpoint: bp.name,
    density: bp.density,
  };
}

