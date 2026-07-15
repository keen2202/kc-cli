// Permission confirmation dialog — ink component (T014)
// Replaces the dead code path in App.ts / PermissionDialog.ts
// Connected via OverlayHost in AppRoot

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export interface PermissionRequest {
  toolName: string;
  inputSummary?: string;
  onDecide: (decision: PermissionDecision) => void;
}

interface PermissionDialogProps {
  request: PermissionRequest;
  onClose: () => void;
}

export function PermissionDialog({ request, onClose }: PermissionDialogProps) {
  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    switch (input.toLowerCase()) {
      case 'y': request.onDecide('allow'); onClose(); break;
      case 'a': request.onDecide('allow_always'); onClose(); break;
      case 'n': request.onDecide('deny'); onClose(); break;
      case 'q': onClose(); break;
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" padding={1}>
      <Box>
        <Text bold color="cyan">
          Permission Required
        </Text>
      </Box>
      <Box>
        <Text>Tool: </Text>
        <Text bold>{request.toolName}</Text>
      </Box>
      {request.inputSummary ? (
        <Box>
          <Text dimColor>
            {request.inputSummary.length > 60
              ? request.inputSummary.slice(0, 57) + '...'
              : request.inputSummary}
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text color="green" bold>[Y]</Text>
        <Text dimColor> Allow Once  </Text>
        <Text color="cyan" bold>[A]</Text>
        <Text dimColor> Allow Always  </Text>
        <Text color="red" bold>[N]</Text>
        <Text dimColor> Deny</Text>
      </Box>
    </Box>
  );
}
