import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';

interface SessionItem {
  id: string;
  name: string;
  model: string;
  messageCount: number;
  lastActive: Date;
}

interface SessionSwitcherProps {
  sessions: SessionItem[];
  onSelect: (sessionId: string) => void;
  onCancel: () => void;
}

export function SessionSwitcher({ sessions, onSelect, onCancel }: SessionSwitcherProps) {
  const { tokens } = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(0);

  return (
    <Box flexDirection="column" borderStyle="single" padding={1} width={50}>
      <Box marginBottom={1}>
        <Text bold>Sessions</Text>
        <Text dimColor> (Ctrl+S to close)</Text>
      </Box>
      {sessions.length === 0 ? (
        <Text dimColor>No saved sessions</Text>
      ) : (
        sessions.map((session, i) => (
          <Box key={session.id} flexDirection="row">
            <Text color={i === selectedIndex ? 'blue' : undefined}>
              {i === selectedIndex ? '▶ ' : '  '}
              {session.name}
            </Text>
            <Text dimColor>
              {' '}· {session.model} · {session.messageCount} msgs
            </Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter: switch · Esc: cancel</Text>
      </Box>
    </Box>
  );
}
