import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { abbreviateModel, truncate } from '../layout';

interface HeaderBarProps {
  provider: string;
  model: string;
  agentMode?: 'build' | 'plan';
  executionMode?: 'interactive' | 'auto' | 'goal';
}

export function HeaderBar({ provider, model, agentMode = 'build', executionMode = 'interactive' }: HeaderBarProps) {
  const { tokens } = useTheme();
  const { width } = useTerminalSize();

  // The header is a fixed single row (HEADER_HEIGHT=1); on narrow terminals we
  // abbreviate the model and clip the plain-text projection so it never wraps.
  const modelLabel = abbreviateModel(model);
  const modeLabel = agentMode === 'build' ? 'Build' : 'Plan';
  // Only surface the automation level when it departs from the interactive
  // default, to keep the single-row header lean.
  const autoLabel = executionMode === 'auto' ? ' · Auto' : executionMode === 'goal' ? ' · Goal' : '';
  const plain = `kc v3.2 · ${provider}/${modelLabel} · Mode: ${modeLabel}${autoLabel}`;
  // paddingLeft/Right consume 2 columns.
  const avail = Math.max(0, width - 2);

  if (plain.length <= avail) {
    return (
      <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <Text>
          {tokens['header.brand']('kc')} v3.2 · {tokens['header.model'](`${provider}/${modelLabel}`)}
          {' '}· Mode: {modeLabel}{autoLabel}
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
