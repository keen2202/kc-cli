import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { formatDuration } from '../format-duration';

interface SessionInfoProps {
  sessionId?: string;
  tokensUsed?: number;
  tokensMax?: number;
  /**
   * Session start timestamp. When provided, the component ticks its own
   * duration once per second — keeping the per-second re-render scoped to
   * this small panel instead of forcing a full app-tree render from AppRoot.
   */
  startTime?: number;
  duration?: number;
}

export function SessionInfo({
  sessionId = '—',
  tokensUsed = 0,
  tokensMax = 200000,
  startTime,
  duration = 0,
}: SessionInfoProps) {
  // Self-contained clock: advance once per second only when startTime is set.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startTime === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startTime]);

  const effectiveDuration = startTime !== undefined ? Math.max(0, now - startTime) : duration;

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
        <Text dimColor>Duration: {formatDuration(effectiveDuration)}</Text>
      </Box>
    </Box>
  );
}
