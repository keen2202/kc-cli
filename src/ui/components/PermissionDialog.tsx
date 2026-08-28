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
  /** Full, untruncated operation detail shown in the expanded dialog. */
  details?: string;
  diffs?: FilePatchPreview[];
  onDecide: (decision: PermissionDecision) => void;
}

interface PermissionDialogProps {
  request: PermissionRequest;
  /** Optional close hook; the dialog always resolves onDecide first. */
  onClose?: () => void;
  /** Row budget from the layout policy — detail/diff sections are windowed
   *  so the dialog never grows past a short terminal. */
  maxRows?: number;
}

export function PermissionDialog({ request, onClose, maxRows }: PermissionDialogProps) {
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

  // Full operation detail, capped to keep the dialog within a sane height; the
  // expanded view exists precisely so the user can read the complete command /
  // arguments (not just the one-line summary) before authorizing. The cap
  // shrinks further on short terminals (layout policy row budget).
  const DETAIL_MAX_LINES_DEFAULT = 16;
  const CHROME_ROWS = 9;
  const detailBudget = Math.max(
    2,
    maxRows !== undefined ? maxRows - CHROME_ROWS : DETAIL_MAX_LINES_DEFAULT,
  );
  const DETAIL_MAX_LINES = Math.min(DETAIL_MAX_LINES_DEFAULT, detailBudget);
  const DIFF_MAX_LINES = Math.max(3, Math.min(20, detailBudget));
  const detailLines = request.details
    ? request.details.replace(/\r\n/g, '\n').split('\n')
    : [];
  const shownDetail = detailLines.slice(0, DETAIL_MAX_LINES);
  const detailTruncated = detailLines.length > DETAIL_MAX_LINES;

  // flexShrink=0: as an in-flow overlay in Layout's fixed-height column this
  // dialog must never be flex-squeezed (rows would collapse onto each other);
  // the chat panel (overflow="hidden") absorbs the shrinkage instead.
  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="single" borderColor={colors.border} padding={1}>
      <Box>
        <Text bold color={colors.primary}>
          Permission Required
        </Text>
      </Box>
      <Box>
        <Text>Tool: </Text>
        <Text bold>{request.toolName}</Text>
      </Box>
      {shownDetail.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.muted} bold>Operation details</Text>
          {shownDetail.map((line, i) => (
            <Text key={`detail-${i}`} wrap="truncate-end">{line === '' ? ' ' : line}</Text>
          ))}
          {detailTruncated ? (
            <Text color={colors.muted} dimColor>… {detailLines.length - DETAIL_MAX_LINES} more line(s)</Text>
          ) : null}
        </Box>
      ) : request.inputSummary ? (
        <Box>
          <Text color={colors.muted}>{request.inputSummary}</Text>
        </Box>
      ) : null}
      {hasDiffs ? (
        <Box marginTop={1}>
          <DiffPreview diffs={fileDiffs} showActions={false} maxLines={DIFF_MAX_LINES} />
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={colors.success} bold>[Y]</Text>
        <Text color={colors.muted}> {hasDiffs ? 'Accept' : 'Allow Once'}  </Text>
        <Text color={colors.primary} bold>[A]</Text>
        <Text color={colors.muted}> Allow Always  </Text>
        <Text color={colors.error} bold>[N]</Text>
        <Text color={colors.muted}> {hasDiffs ? 'Reject' : 'Deny'}  </Text>
        <Text color={colors.muted} dimColor>[Esc] Back</Text>
      </Box>
    </Box>
  );
}
