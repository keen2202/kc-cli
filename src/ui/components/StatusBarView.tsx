import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { useNowTick } from '../hooks/useNowTick';
import { abbreviateModel, truncate, getBreakpoint } from '../layout';
import { formatDurationSec } from '../format-duration';

interface StatusBarProps {
  mode: 'idle' | 'streaming' | 'executing' | 'error' | 'overlay' | 'steer';
  provider: string;
  model: string;
  turnCount: number;
  maxTurns: number;
  tokensUsed?: number;
  /** Name of the tool currently running, shown as `· running: <name>`. */
  currentOperation?: string;
  /** Seconds the current operation has been running (live-ticked). Prefer
   *  `operationStartTime` for the live path; this stays for direct/test use. */
  operationElapsedSec?: number;
  /** Start timestamp of the running operation. When set, the bar self-ticks
   *  the elapsed time internally (no per-second re-render of the app tree). */
  operationStartTime?: number;
  /** Overall progress 0-100 (turn-based normally, iteration-based in goal mode). */
  progressPercent?: number;
  /** Estimated seconds remaining for the current query (best-effort). Prefer
   *  the `queryStartTime`/`eta*Units` inputs for the live path. */
  etaSec?: number;
  /** Query start timestamp; with the unit counts below the bar self-ticks the ETA. */
  queryStartTime?: number;
  /** Units completed so far (turns, or goal iterations) for the ETA estimate. */
  etaCompletedUnits?: number;
  /** Units still remaining for the ETA estimate. */
  etaRemainingUnits?: number;
}

const MODE_ICONS: Record<string, string> = {
  idle: '○',
  streaming: '●',
  executing: '▶',
  error: '✖',
  overlay: '◉',
  steer: '◇',
};

const MODE_LABELS: Record<string, string> = {
  idle: 'idle',
  streaming: 'streaming',
  executing: 'executing',
  error: 'error',
  overlay: 'overlay',
  steer: 'steer',
};

export function StatusBar({ mode, provider, model, turnCount, maxTurns, tokensUsed, currentOperation, operationElapsedSec, operationStartTime, progressPercent, etaSec, queryStartTime, etaCompletedUnits, etaRemainingUnits }: StatusBarProps) {
  const { tokens } = useTheme();
  const { width } = useTerminalSize();
  const icon = MODE_ICONS[mode] || '○';
  const label = MODE_LABELS[mode] || mode;

  // Live time is ticked here (scoped to the one-row bar) rather than lifted to
  // AppRoot, so a running clock never repaints the whole frame. Precomputed
  // `operationElapsedSec`/`etaSec` still win when start timestamps are absent
  // (direct/test use).
  const tickActive = operationStartTime !== undefined || queryStartTime !== undefined;
  const now = useNowTick(tickActive);
  const liveOpElapsed = operationStartTime !== undefined
    ? Math.max(0, (now - operationStartTime) / 1000)
    : operationElapsedSec;
  const liveEta = queryStartTime !== undefined
    && etaCompletedUnits !== undefined && etaCompletedUnits > 0
    && etaRemainingUnits !== undefined && etaRemainingUnits > 0
    ? ((now - queryStartTime) / 1000 / etaCompletedUnits) * etaRemainingUnits
    : etaSec;

  // Progress bar follows progressPercent when provided (goal mode reports
  // iteration progress there); otherwise fall back to turn-based progress.
  const ratio = progressPercent !== undefined
    ? Math.min(1, Math.max(0, progressPercent / 100))
    : turnCount / Math.max(1, maxTurns);
  const progressFilled = Math.round(ratio * 10);
  const progressBar = '█'.repeat(progressFilled) + '░'.repeat(Math.max(0, 10 - progressFilled));

  const modelLabel = abbreviateModel(model);
  const tokenSuffix = tokensUsed !== undefined ? ` · ${tokensUsed} tokens` : '';
  // Live operation + progress percent are the lowest-priority segments: they
  // are appended after the essentials and dropped first when width is tight.
  const pct = progressPercent !== undefined ? ` ${Math.round(progressPercent)}%` : '';
  const eta = liveEta !== undefined && liveEta > 0 ? ` · ETA ~${formatDurationSec(liveEta)}` : '';
  const opElapsed = liveOpElapsed !== undefined ? ` (${formatDurationSec(liveOpElapsed)})` : '';
  const opSuffix = currentOperation ? ` · running: ${currentOperation}${opElapsed}` : '';
  const plain = `${icon} ${label} ${provider}/${modelLabel} ${progressBar} ${turnCount}/${maxTurns}${pct}${eta}${opSuffix}${tokenSuffix}`;
  const avail = Math.max(0, width - 2);

  // On the tiny breakpoint (<60 cols) drop the provider/model, progress bar and
  // token count so the fixed single row shows only the essential mode + turns.
  if (getBreakpoint(width).name === 'tiny') {
    return (
      <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <Text>{truncate(`${icon} ${label} ${turnCount}/${maxTurns}`, avail)}</Text>
      </Box>
    );
  }

  // Fixed single-row status bar (STATUS_BAR_HEIGHT=1). Clip on narrow widths so
  // it never wraps and shifts the layout.
  if (plain.length <= avail) {
    return (
      <Box flexDirection="row" paddingLeft={1} paddingRight={1}>
        <Text>
          {icon} {label}{' '}
          {tokens['status.model'](`${provider}/${modelLabel}`)}{' '}
          {progressBar} {turnCount}/{maxTurns}{pct}{eta}
          {currentOperation ? ` · running: ${currentOperation}${opElapsed}` : ''}
          {tokensUsed !== undefined ? ` · ${tokens['status.tokens'](`${tokensUsed} tokens`)}` : ''}
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
