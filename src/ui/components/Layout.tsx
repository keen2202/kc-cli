import React, { type ReactNode } from 'react';
import { Box } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { computeOpenCodeLayout, type OpenCodeLayout } from '../layout';

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

export function Layout({ headerBar, chatPanel, editor, errorBar, operationSummary, sessionInfo, sidebar, statusBar, overlay, sidebarHidden }: LayoutProps) {
  const { width, height } = useTerminalSize();
  const dims: OpenCodeLayout = computeOpenCodeLayout(width, height, {
    errorVisible: errorBar != null,
    operationVisible: operationSummary != null,
  });
  const sidebarVisible = dims.sidebarVisible && !sidebarHidden;
  const rightPanelWidth = sidebarVisible ? dims.rightPanelWidth : 0;
  // The sidebar occupies the main content row minus the session-info block
  // above it; pass that budget down so it can size its item lists.
  const sidebarHeight = Math.max(
    1,
    dims.contentHeight + dims.editorHeight + dims.errorBarHeight + dims.operationHeight - dims.sessionInfoHeight,
  );
  const sidebarWithSize = React.isValidElement(sidebar)
    ? React.cloneElement(sidebar as React.ReactElement<any>, {
        height: sidebarHeight,
        width: rightPanelWidth,
      })
    : sidebar;

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header bar */}
      {dims.headerVisible && (
        <Box height={dims.headerHeight}>{headerBar}</Box>
      )}

      {/* Main area: left (chat + editor) + right (session info + sidebar) */}
      <Box flexDirection="row" height={dims.contentHeight + dims.editorHeight + dims.errorBarHeight + dims.operationHeight}>
        {/* Left pane */}
        <Box flexDirection="column" flexGrow={1} width={width - rightPanelWidth}>
          {/* Chat panel. overflow="hidden" clips overflowing chat output to its
              allotted height so stale content never bleeds into the editor
              below when the terminal is resized (small -> large). */}
          <Box height={dims.contentHeight} overflow="hidden">{chatPanel}</Box>
          {/* Error banner sits directly above the editor so it is always
              visible near the input without scrolling the chat output. */}
          {errorBar != null && (
            <Box height={dims.errorBarHeight}>{errorBar}</Box>
          )}
          {/* Operation summary: what is about to run / running, above the editor. */}
          {operationSummary != null && (
            <Box height={dims.operationHeight}>{operationSummary}</Box>
          )}
          {/* Editor. flexShrink={0} keeps its full height so the chat panel can
              never squeeze or overlap the input line. */}
          <Box height={dims.editorHeight} flexShrink={0}>{editor}</Box>
        </Box>

        {/* Right pane */}
        {sidebarVisible && (
          <Box flexDirection="column" width={rightPanelWidth}>
            {/* Session info (top-right) */}
            <Box height={dims.sessionInfoHeight}>{sessionInfo}</Box>
            {/* Sidebar (bottom-right) */}
            <Box flexGrow={1}>{sidebarWithSize}</Box>
          </Box>
        )}
      </Box>

      {/* Status bar */}
      <Box height={dims.statusBarHeight}>{statusBar}</Box>

      {/* Overlay host */}
      {overlay}
    </Box>
  );
}
