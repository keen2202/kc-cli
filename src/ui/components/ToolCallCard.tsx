import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import type { ToolCallData } from './ToolCallCard';

const STATUS_ICONS: Record<string, string> = {
  pending: '○',
  running: '◌',
  completed: '✓',
  failed: '✗',
};

interface ToolCallCardViewProps {
  toolCall: ToolCallData;
}

export function ToolCallCardView({ toolCall }: ToolCallCardViewProps) {
  const { tokens } = useTheme();
  const icon = STATUS_ICONS[toolCall.status] || '○';

  const elapsed = toolCall.startTime
    ? `${(((toolCall.endTime || Date.now()) - toolCall.startTime) / 1000).toFixed(1)}s`
    : '—';

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Text>
          {toolCall.status === 'running' && tokens['tool.running'](`${icon} ${toolCall.toolName}`)}
          {toolCall.status === 'completed' && tokens['tool.success'](`${icon} ${toolCall.toolName}`)}
          {toolCall.status === 'failed' && tokens['tool.failed'](`${icon} ${toolCall.toolName}`)}
          {toolCall.status === 'pending' && `${icon} ${toolCall.toolName}`}
          {'  '}
          <Text dimColor>{elapsed}</Text>
        </Text>
      </Box>
      {toolCall.output && toolCall.status === 'failed' && (
        <Box marginLeft={2}>
          <Text color="red">{toolCall.output.slice(0, 200)}</Text>
        </Box>
      )}
    </Box>
  );
}
