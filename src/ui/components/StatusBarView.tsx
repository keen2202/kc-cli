import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { abbreviateModel, truncate, getBreakpoint } from '../layout';

interface StatusBarProps {
  mode: 'idle' | 'streaming' | 'overlay' | 'steer';
  provider: string;
  model: string;
  turnCount: number;
  maxTurns: number;
  tokensUsed?: number;
  /** Name of the tool currently running, shown as `· running: <name>`. */
  currentOperation?: string;
  /** Overall progress 0-100 (turn-based normally, iteration-based in goal mode). */
  progressPercent?: number;
}

const MODE_ICONS: Record<string, string> = {
  idle: '○',
  streaming: '●',
  overlay: '◉',
  steer: '◇',
};

const MODE_LABELS: Record<string, string> = {
  idle: 'idle',
  streaming: 'streaming',
  overlay: 'overlay',
  steer: 'steer',
};

export function StatusBar({ mode, provider, model, turnCount, maxTurns, tokensUsed, currentOperation, progressPercent }: StatusBarProps) {
  const { tokens } = useTheme();
  const { width } = useTerminalSize();
  const icon = MODE_ICONS[mode] || '○';
  const label = MODE_LABELS[mode] || mode;

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
  const opSuffix = currentOperation ? ` · running: ${currentOperation}` : '';
  const plain = `${icon} ${label} ${provider}/${modelLabel} ${progressBar} ${turnCount}/${maxTurns}${pct}${opSuffix}${tokenSuffix}`;
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
          {progressBar} {turnCount}/{maxTurns}{pct}
          {currentOperation ? ` · running: ${currentOperation}` : ''}
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
