import React from 'react';
import { Box, Text, useInput } from 'ink';

interface QuitConfirmProps {
  onConfirm: () => void;
  onCancel: () => void;
}

export function QuitConfirm({ onConfirm, onCancel }: QuitConfirmProps) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onConfirm();
      return;
    }
    if (key.escape || input === 'n' || input === 'N') {
      onCancel();
    }
  });
  return (
    <Box flexDirection="column" borderStyle="single" padding={1}>
      <Box marginBottom={1}>
        <Text bold>Quit kc-cli?</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>Any unsaved changes will be preserved in session history.</Text>
      </Box>
      <Box flexDirection="row">
        <Text>[Y] Yes, quit  </Text>
        <Text dimColor>[N/Esc] Cancel</Text>
      </Box>
    </Box>
  );
}
