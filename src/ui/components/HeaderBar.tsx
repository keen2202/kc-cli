import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { abbreviateModel, truncate } from '../layout';

interface HeaderBarProps {
  provider: string;
  model: string;
  agentMode?: 'build' | 'plan';
}

export function HeaderBar({ provider, model, agentMode = 'build' }: HeaderBarProps) {
  const { tokens } = useTheme();
  const { width } = useTerminalSize();

  // The header is a fixed single row (HEADER_HEIGHT=1); on narrow terminals we
  // abbreviate the model and clip the plain-text projection so it never wraps.
  const modelLabel = abbreviateModel(model);
  const modeLabel = agentMode === 'build' ? 'Build' : 'Plan';
  const plain = `kc v3.2 · ${provider}/${modelLabel} · Mode: ${modeLabel}`;
  // paddingLeft/Right consume 2 columns.
  const avail = Math.max(0, width - 2);

  if (plain.length <= avail) {
    return (
      <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <Text>
          {tokens['header.brand']('kc')} v3.2 · {tokens['header.model'](`${provider}/${modelLabel}`)}
          {' '}· Mode: {modeLabel}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <Text>{truncate(plain, avail)}</Text>
    </Box>
  );
}
