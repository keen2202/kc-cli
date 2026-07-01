import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';

interface StatusBarProps {
  mode: 'idle' | 'streaming' | 'overlay' | 'steer';
  provider: string;
  model: string;
  turnCount: number;
  maxTurns: number;
  tokensUsed?: number;
}

const MODE_ICONS: Record<string, string> = {
  idle: '○',
  streaming: '●',
  overlay: '◉',
  steer: '◇',
};

const MODE_LABELS: Record<string, string> = {
  idle: 'idle',
  streaming: 'streaming',
  overlay: 'overlay',
  steer: 'steer',
};

export function StatusBar({ mode, provider, model, turnCount, maxTurns, tokensUsed }: StatusBarProps) {
  const { tokens } = useTheme();
  const icon = MODE_ICONS[mode] || '○';
  const label = MODE_LABELS[mode] || mode;

  const progressFilled = Math.round((turnCount / Math.max(1, maxTurns)) * 10);
  const progressBar = '█'.repeat(progressFilled) + '░'.repeat(Math.max(0, 10 - progressFilled));

  return (
    <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Text>
        {icon} {label}{' '}
        {tokens['status.model'](`${provider}/${model}`)}{' '}
        {progressBar} {turnCount}/{maxTurns}
        {tokensUsed !== undefined ? ` · ${tokens['status.tokens'](`${tokensUsed} tokens`)}` : ''}
      </Text>
    </Box>
  );
}
