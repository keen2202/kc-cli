import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import type { ThinkingChain, ThinkingStep } from './ThinkingChainView';

interface ThinkingChainViewProps {
  chain: ThinkingChain;
}

export function ThinkingChainViewInk({ chain }: ThinkingChainViewProps) {
  const { tokens } = useTheme();
  const [folded, setFolded] = useState(chain.folded ?? true);

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row">
        <Text dimColor>
          {folded ? '▶' : '▼'} Thinking
          {chain.steps.length > 0 && ` (${chain.steps.length} steps)`}
          {' · '}
          {chain.startTime ? `${((Date.now() - chain.startTime) / 1000).toFixed(1)}s` : ''}
        </Text>
      </Box>
      {!folded && chain.steps.map((step, i) => (
        <Box key={i} marginLeft={2} flexDirection="column">
          <Text dimColor>
            {step.label}: {step.content.slice(0, 120)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
