import React from 'react';
import { Box, Text } from 'ink';
import { formatDuration } from '../format-duration';

interface SessionInfoProps {
  sessionId?: string;
  tokensUsed?: number;
  tokensMax?: number;
  duration?: number;
}

export function SessionInfo({
  sessionId = '—',
  tokensUsed = 0,
  tokensMax = 200000,
  duration = 0,
}: SessionInfoProps) {
  const formatTokens = (n: number) => {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };

  // Provider/model intentionally omitted here — the HeaderBar is the single
  // source of truth for the active provider/model to avoid duplicate display.
  // The block renders at its natural height (border + padding + 4 rows) and
  // the Layout right column gives it flexShrink={0}; no layout constant
  // mirrors this shape (spec §3.2.2 — the component owns its height).
  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Text bold>Session Info</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text dimColor>Session: {sessionId}</Text>
        <Text dimColor>
          Tokens: {formatTokens(tokensUsed)}/{formatTokens(tokensMax)}
        </Text>
        <Text dimColor>Duration: {formatDuration(duration)}</Text>
      </Box>
    </Box>
  );
}
