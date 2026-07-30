// Operation summary strip rendered directly above the editor.
//
// Two modes:
//   - 'confirm': an interactive-mode tool is awaiting authorization. Shows the
//     tool, a one-line summary, derived steps and expected result, plus an
//     inline confirm affordance. AppRoot's useInput resolves the decision.
//   - 'live': auto/goal mode is executing autonomously. Shows what is currently
//     running (no confirmation), optionally flagged as auto-approved.
//
// The strip owns its own height bound: visible operations are capped, every
// content row is a single truncated line, and compact widths collapse the
// detail rows — so its natural height has a fixed ceiling and Yoga measures
// it directly (no reserved slot in layout.ts).

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { truncate } from '../layout';
import { computeDiff } from '../diff-viewer';
import type { FilePatchPreview } from '../../permissions/protocol';

export interface OperationItem {
  toolName: string;
  /** One-line human-readable summary of the tool input, when available. */
  summary?: string;
  /** Ordered steps the operation will take. */
  steps: string[];
  /** Expected outcome, e.g. "Modify 2 file(s): a.ts, b.ts". */
  expected: string;
  /** Pending file changes, when the tool writes/edits files. */
  diffs?: FilePatchPreview[];
  status?: 'pending' | 'running' | 'completed' | 'failed';
}

interface SidebarToolLike {
  name: string;
  status: 'running' | 'completed' | 'failed' | 'pending';
  duration?: string;
}

/**
 * Derive human-readable steps + expected result from a pending tool
 * authorization request. Kept pure and exported for unit testing.
 */
export function synthesizeOperation(
  toolName: string,
  inputSummary?: string,
  diffs?: FilePatchPreview[],
): OperationItem {
  const name = toolName.toLowerCase();
  let steps: string[];
  let expected: string;

  if (diffs && diffs.length > 0) {
    const files = diffs.map((d) => d.filePath);
    steps = files.map((f) => `Edit ${f}`);
    const shown = files.slice(0, 3).join(', ');
    expected = `Modify ${files.length} file(s): ${shown}${files.length > 3 ? ', …' : ''}`;
  } else if (name.includes('write') || name.includes('edit')) {
    steps = ['Locate target file', 'Apply changes'];
    expected = 'File contents updated';
  } else if (name.includes('bash') || name.includes('run')) {
    steps = ['Execute shell command'];
    expected = 'Command output captured';
  } else if (name.includes('git')) {
    steps = ['Run git operation'];
    expected = 'Repository state updated';
  } else {
    steps = [`Invoke ${toolName}`];
    expected = 'Tool result returned';
  }

  return { toolName, summary: inputSummary, steps, expected, diffs };
}

/** Build live operation items from the sidebar's tool list (running/pending). */
export function operationsFromTools(tools: SidebarToolLike[]): OperationItem[] {
  return tools
    .filter((t) => t.status === 'running' || t.status === 'pending')
    .map((t) => ({ toolName: t.name, steps: [], expected: '', status: t.status }));
}

export interface CondensedDiff {
  adds: number;
  removes: number;
  fileCount: number;
  /** First few changed lines (add/remove only) for an at-a-glance preview. */
  sampleLines: Array<{ type: 'add' | 'remove'; content: string }>;
}

/**
 * Summarize pending file patches into total +/- counts and a bounded sample of
 * changed lines, so the fixed-height confirm strip can show an at-a-glance diff
 * without overflowing its layout budget. Kept pure and exported for testing.
 */
export function condenseDiffs(diffs: FilePatchPreview[], maxSampleLines: number): CondensedDiff {
  let adds = 0;
  let removes = 0;
  const sampleLines: CondensedDiff['sampleLines'] = [];
  for (const d of diffs) {
    const lines = computeDiff(d.oldContent ?? '', d.newContent);
    for (const line of lines) {
      if (line.type === 'add') {
        adds++;
        if (sampleLines.length < maxSampleLines) sampleLines.push({ type: 'add', content: line.content });
      } else if (line.type === 'remove') {
        removes++;
        if (sampleLines.length < maxSampleLines) sampleLines.push({ type: 'remove', content: line.content });
      }
    }
  }
  return { adds, removes, fileCount: diffs.length, sampleLines };
}

interface OperationSummaryProps {
  operations: OperationItem[];
  mode: 'confirm' | 'live';
  /** Hide steps/expected and show only a single line (compact/tiny breakpoints). */
  compact?: boolean;
  /** In live mode, annotate that operations were auto-approved. */
  autoApproved?: boolean;
}

export function OperationSummary({ operations, mode, compact = false, autoApproved = false }: OperationSummaryProps) {
  const { colors } = useTheme();
  if (operations.length === 0) return null;

  const title = mode === 'confirm' ? 'Pending Operation' : 'Running';
  // Cap visible operations so the strip's natural height stays bounded:
  // confirm shows a single op (its steps/expected make it 3 rows tall); live
  // shows up to 3 one-line ops, or a single op on compact widths.
  const maxVisible = mode === 'confirm' ? 1 : compact ? 1 : 3;
  const visible = operations.slice(0, maxVisible);
  // In confirm mode the user can always expand the request into the full-detail
  // dialog (Ctrl+O) to review the complete operation before deciding.
  const canExpand = mode === 'confirm';

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={colors.border} paddingLeft={1} paddingRight={1}>
      <Box>
        <Text bold color={colors.primary}>{title}</Text>
        {mode === 'live' && autoApproved ? <Text color={colors.muted}> · auto-approved</Text> : null}
      </Box>
      {visible.map((op, i) => {
        const opDiffs = mode === 'confirm' ? op.diffs : undefined;
        const hasDiffs = !!opDiffs && opDiffs.length > 0;
        // Sample at most 2 changed lines on normal widths (keeps the strip's
        // ceiling at title + op-name + summary + 2 lines + confirm); none on compact.
        const condensed = hasDiffs ? condenseDiffs(opDiffs!, compact ? 0 : 2) : null;
        return (
          <Box key={`${op.toolName}-${i}`} flexDirection="column">
            <Box>
              <Text color={colors.success}>{op.status === 'running' ? '● ' : '→ '}</Text>
              <Text bold>{op.toolName}</Text>
              {condensed ? (
                <Text color={colors.muted}> +{condensed.adds} -{condensed.removes}</Text>
              ) : op.summary ? (
                <Text color={colors.muted} wrap="truncate-end"> {truncate(op.summary, 48)}</Text>
              ) : null}
            </Box>
            {condensed && !compact ? (
              <>
                <Text color={colors.muted} wrap="truncate-end">
                  {'  '}{condensed.fileCount} file(s) · +{condensed.adds} -{condensed.removes}
                </Text>
                {condensed.sampleLines.map((line, li) => (
                  <Text key={`diff-${li}`} color={line.type === 'add' ? colors.success : colors.error} wrap="truncate-end">
                    {'  '}{line.type === 'add' ? '+' : '-'} {truncate(line.content, 58)}
                  </Text>
                ))}
              </>
            ) : null}
            {!condensed && !compact && op.steps.length > 0 ? (
              <Text color={colors.muted} wrap="truncate-end">  steps: {truncate(op.steps.slice(0, 3).join(' \u2192 '), 60)}</Text>
            ) : null}
            {!condensed && !compact && op.expected ? (
              <Text color={colors.muted} wrap="truncate-end">  expected: {truncate(op.expected, 60)}</Text>
            ) : null}
          </Box>
        );
      })}
      {mode === 'confirm' ? (
        <Box>
          <Text color={colors.success} bold>[Enter]</Text>
          <Text color={colors.muted}> Confirm  </Text>
          <Text color={colors.primary} bold>[A]</Text>
          <Text color={colors.muted}> Always  </Text>
          <Text color={colors.error} bold>[Esc]</Text>
          <Text color={colors.muted}> Cancel</Text>
          {canExpand ? (
            <>
              <Text color={colors.muted}>  </Text>
              <Text color={colors.primary} bold>[Ctrl+O]</Text>
              <Text color={colors.muted}> Details</Text>
            </>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}

export default OperationSummary;
