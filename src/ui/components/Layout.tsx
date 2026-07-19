import React, { type ReactNode } from 'react';
import { Box } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { computeOpenCodeLayout, type OpenCodeLayout } from '../layout';

interface LayoutProps {
  headerBar: ReactNode;
  chatPanel: ReactNode;
  editor: ReactNode;
  errorBar?: ReactNode;
  sessionInfo: ReactNode;
  sidebar: ReactNode;
  statusBar: ReactNode;
  overlay: ReactNode;
  /** User override to hide the right panel even when the breakpoint allows it. */
  sidebarHidden?: boolean;
}

export function Layout({ headerBar, chatPanel, editor, errorBar, sessionInfo, sidebar, statusBar, overlay, sidebarHidden }: LayoutProps) {
  const { width, height } = useTerminalSize();
  const dims: OpenCodeLayout = computeOpenCodeLayout(width, height, { errorVisible: errorBar != null });
  const sidebarVisible = dims.sidebarVisible && !sidebarHidden;
  const rightPanelWidth = sidebarVisible ? dims.rightPanelWidth : 0;
  // The sidebar occupies the main content row minus the session-info block
  // above it; pass that budget down so it can size its item lists.
  const sidebarHeight = Math.max(
    1,
    dims.contentHeight + dims.editorHeight + dims.errorBarHeight - dims.sessionInfoHeight,
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
      <Box flexDirection="row" height={dims.contentHeight + dims.editorHeight + dims.errorBarHeight}>
        {/* Left pane */}
        <Box flexDirection="column" flexGrow={1} width={width - rightPanelWidth}>
          {/* Chat panel */}
          <Box height={dims.contentHeight}>{chatPanel}</Box>
          {/* Error banner sits directly above the editor so it is always
              visible near the input without scrolling the chat output. */}
          {errorBar != null && (
            <Box height={dims.errorBarHeight}>{errorBar}</Box>
          )}
          {/* Editor */}
          <Box height={dims.editorHeight}>{editor}</Box>
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
