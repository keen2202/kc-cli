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
}

export function Layout({ headerBar, chatPanel, editor, errorBar, sessionInfo, sidebar, statusBar, overlay }: LayoutProps) {
  const { width, height } = useTerminalSize();
  const dims: OpenCodeLayout = computeOpenCodeLayout(width, height, { errorVisible: errorBar != null });

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Header bar */}
      {dims.headerVisible && (
        <Box height={dims.headerHeight}>{headerBar}</Box>
      )}

      {/* Main area: left (chat + editor) + right (session info + sidebar) */}
      <Box flexDirection="row" height={dims.contentHeight + dims.editorHeight + dims.errorBarHeight}>
        {/* Left pane */}
        <Box flexDirection="column" flexGrow={1} width={width - dims.rightPanelWidth}>
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
        {dims.sidebarVisible && (
          <Box flexDirection="column" width={dims.rightPanelWidth}>
            {/* Session info (top-right) */}
            <Box height={dims.sessionInfoHeight}>{sessionInfo}</Box>
            {/* Sidebar (bottom-right) */}
            <Box flexGrow={1}>{sidebar}</Box>
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
