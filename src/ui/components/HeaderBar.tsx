import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';

interface HeaderBarProps {
  provider: string;
  model: string;
  agentMode?: 'build' | 'plan';
}

export function HeaderBar({ provider, model, agentMode = 'build' }: HeaderBarProps) {
  const { tokens } = useTheme();

  return (
    <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Text>
        {tokens['header.brand']('kc')} v3.2 · {tokens['header.model'](`${provider}/${model}`)}
        {' '}· {agentMode === 'build' ? 'Build' : 'Plan'}
      </Text>
    </Box>
  );
}
