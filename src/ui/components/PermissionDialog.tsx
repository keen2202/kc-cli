// Permission confirmation dialog — ink component.
// Rendered by AppRoot's overlay host when a tool requires interactive
// authorization. When file diffs are attached, they are shown inline so the
// user reviews the exact change before approving ("review → authorize").

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useFocusLayer } from '../hooks/useFocusLayer';
import type { KeypressEvent } from '../keypress';
import DiffPreview, { type FileDiff } from './DiffPreview';
import type { FilePatchPreview } from '../../permissions/protocol';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export interface PermissionRequest {
  toolName: string;
  inputSummary?: string;
  diffs?: FilePatchPreview[];
  onDecide: (decision: PermissionDecision) => void;
}

interface PermissionDialogProps {
  request: PermissionRequest;
  /** Optional close hook; the dialog always resolves onDecide first. */
  onClose?: () => void;
}

export function PermissionDialog({ request, onClose }: PermissionDialogProps) {
  const { colors } = useTheme();

  // Every decision path resolves onDecide exactly once so the awaiting
  // executor Promise can never deadlock. This dialog is the expanded
  // diff-detail focus layer stacked above the inline permission layer: ESC
  // closes the diff first (back to the inline confirm strip); the permission
  // layer beneath then owns the next ESC (deny). Stack order guarantees the
  // sequencing — no manual guards needed.
  const decide = (decision: PermissionDecision) => {
    request.onDecide(decision);
    onClose?.();
  };

  useFocusLayer({
    id: 'diff-detail',
    onKey: (event: KeypressEvent) => {
      switch (event.name.toLowerCase()) {
        case 'y': decide('allow'); break;
        case 'a': decide('allow_always'); break;
        case 'n':
        case 'r':
        case 'q': decide('deny'); break;
      }
      return true;
    },
    onEscape: () => {
      onClose?.();
      return true;
    },
  });

  const hasDiffs = !!request.diffs && request.diffs.length > 0;
  const fileDiffs: FileDiff[] = hasDiffs
    ? request.diffs!.map((d: FilePatchPreview) => ({
        filePath: d.filePath,
        oldContent: d.oldContent,
        newContent: d.newContent,
        accepted: false,
        rejected: false,
      }))
    : [];

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={colors.border} padding={1}>
      <Box>
        <Text bold color={colors.primary}>
          Permission Required
        </Text>
      </Box>
      <Box>
        <Text>Tool: </Text>
        <Text bold>{request.toolName}</Text>
      </Box>
      {request.inputSummary ? (
        <Box>
          <Text color={colors.muted}>
            {request.inputSummary.length > 60
              ? request.inputSummary.slice(0, 57) + '...'
              : request.inputSummary}
          </Text>
        </Box>
      ) : null}
      {hasDiffs ? (
        <Box marginTop={1}>
          <DiffPreview diffs={fileDiffs} showActions={false} maxLines={20} />
        </Box>
      ) : null}
      <Box marginTop={hasDiffs ? 1 : 0}>
        <Text color={colors.success} bold>[Y]</Text>
        <Text color={colors.muted}> {hasDiffs ? 'Accept' : 'Allow Once'}  </Text>
        <Text color={colors.primary} bold>[A]</Text>
        <Text color={colors.muted}> Allow Always  </Text>
        <Text color={colors.error} bold>[N]</Text>
        <Text color={colors.muted}> {hasDiffs ? 'Reject' : 'Deny'}</Text>
      </Box>
    </Box>
  );
}
