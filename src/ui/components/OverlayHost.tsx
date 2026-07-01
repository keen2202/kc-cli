import React from 'react';
import { Box, Text } from 'ink';
import type { OverlayManager } from '../overlay-manager';
import { useTheme } from '../hooks/useTheme';
import { useTerminalSize } from '../hooks/useTerminalSize';

interface OverlayHostProps {
  overlayManager: OverlayManager;
}

/**
 * Renders the topmost overlay from the OverlayManager stack
 * with a dimmed backdrop. Mimics opencode's dialog rendering pattern.
 */
export function OverlayHost({ overlayManager }: OverlayHostProps) {
  const { tokens } = useTheme();
  const { width, height } = useTerminalSize();

  if (overlayManager.isEmpty()) return null;

  const top = overlayManager.getTop();
  if (!top) return null;

  // Render overlay content via the existing render() method
  const theme = { resolve: () => tokens } as any;
  const result = top.render(width, height, theme);

  return (
    <Box flexDirection="column" position="absolute">
      {/* Dimmed backdrop */}
      <Box width={width} height={height}>
        <Text dimColor>{'░'.repeat(width)}</Text>
      </Box>
      {/* Overlay content — positioned at center */}
      <Box flexDirection="column">
        {result.lines.map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>
    </Box>
  );
}
