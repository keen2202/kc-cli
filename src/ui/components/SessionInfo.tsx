import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';

interface SessionInfoProps {
  provider: string;
  model: string;
  sessionId?: string;
  tokensUsed?: number;
  tokensMax?: number;
  duration?: number;
}

export function SessionInfo({
  provider,
  model,
  sessionId = '—',
  tokensUsed = 0,
  tokensMax = 200000,
  duration = 0,
}: SessionInfoProps) {
  const { tokens } = useTheme();

  const formatDuration = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Text bold>Session Info</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text>{tokens['header.model']('Model:')} {model}</Text>
        <Text>{tokens['header.model']('Provider:')} {provider}</Text>
        <Text dimColor>Session: {sessionId}</Text>
        <Text dimColor>
          Tokens: {formatTokens(tokensUsed)}/{formatTokens(tokensMax)}
        </Text>
        <Text dimColor>Duration: {formatDuration(duration)}</Text>
      </Box>
    </Box>
  );
}
