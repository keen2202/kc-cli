import React, { type ReactNode } from 'react';
import { Box } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { computeOpenCodeLayout } from '../layout';

interface LayoutProps {
  headerBar: ReactNode;
  chatPanel: ReactNode;
  editor: ReactNode;
  errorBar?: ReactNode;
  operationSummary?: ReactNode;
  sessionInfo: ReactNode;
  sidebar: ReactNode;
  statusBar: ReactNode;
  overlay: ReactNode;
  /** User override to hide the right panel even when the breakpoint allows it. */
  sidebarHidden?: boolean;
}

/**
 * Pure-flex frame: Yoga owns all measurement, layout.ts only supplies policy
 * (breakpoints, panel widths, the editor's target height). The chat box is the
 * single flexGrow element in the left column, so the editor sits on the status
 * bar structurally — no row arithmetic, no reverse-engineered component
 * heights (spec §3.2.1). Fixed-height strips are flexShrink={0}; everything
 * else takes its natural height and the row clips overflow defensively.
 */
export function Layout({ headerBar, chatPanel, editor, errorBar, operationSummary, sessionInfo, sidebar, statusBar, overlay, sidebarHidden }: LayoutProps) {
  const { width, height } = useTerminalSize();
  const layout = computeOpenCodeLayout(width, height);
  const sidebarVisible = layout.sidebarVisible && !sidebarHidden;
  const rightPanelWidth = sidebarVisible ? layout.rightPanelWidth : 0;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header bar */}
      {layout.headerVisible && (
        <Box height={layout.headerHeight} flexShrink={0}>{headerBar}</Box>
      )}

      {/* Main area fills whatever the header/status strips leave over; it
          clips its content so a too-short terminal can never push the status
          bar off screen. */}
      <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        {/* Left pane */}
        <Box flexDirection="column" flexGrow={1} width={width - rightPanelWidth}>
          {/* Chat panel: the only flexGrow element, so it absorbs all spare
              rows and shrinks first. overflow="hidden" clips overflowing chat
              output so stale content never bleeds into the editor below. */}
          <Box flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">{chatPanel}</Box>
          {/* Error banner: natural height (the component bounds itself),
              directly above the editor so it is visible without scrolling. */}
          {errorBar != null && (
            <Box flexShrink={0}>{errorBar}</Box>
          )}
          {/* Operation summary: what is about to run / running, above the editor. */}
          {operationSummary != null && (
            <Box flexShrink={0}>{operationSummary}</Box>
          )}
          {/* Editor: policy-sized target height, never squeezed (flexShrink=0),
              anchored to the bottom because chat is the only grower. */}
          <Box height={layout.editorHeight} flexShrink={0}>{editor}</Box>
        </Box>

        {/* Right pane: session info takes its natural height, the sidebar
            fills the remainder, measures its own allotment (measureElement)
            and clips its own overflow — height truth lives in one place. */}
        {sidebarVisible && (
          <Box flexDirection="column" width={rightPanelWidth}>
            <Box flexShrink={0}>{sessionInfo}</Box>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">{sidebar}</Box>
          </Box>
        )}
      </Box>

      {/* Status bar */}
      <Box height={layout.statusBarHeight} flexShrink={0}>{statusBar}</Box>

      {/* Overlay host */}
      {overlay}
    </Box>
  );
}
