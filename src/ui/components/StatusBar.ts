import chalk from 'chalk';
import type { Theme } from '../theme';

interface StatusBarData {
  provider?: string;
  model?: string;
  turnCount?: number;
  maxTurns?: number;
  tokensUsed?: number;
  sessionStartTime?: number;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m${secs}s`;
}

function renderProgressBar(percent: number, width: number = 10, theme?: Theme): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const tokens = theme?.resolve();
  const fillColor = tokens ? tokens['tool.success'] : chalk.green;
  const emptyColor = chalk.gray;
  return fillColor('█'.repeat(filled)) + emptyColor('░'.repeat(empty));
}

export function renderStatusBar(data: StatusBarData, theme?: Theme): string {
  const tokens = theme?.resolve();
  const parts: string[] = [];

  if (data.provider && data.model) {
    const modelColor = tokens ? tokens['status.model'] : chalk.cyan;
    parts.push(modelColor(`${data.provider}/${data.model}`));
  }

  if (data.turnCount !== undefined && data.maxTurns !== undefined) {
    const pct = Math.round((data.turnCount / data.maxTurns) * 100);
    parts.push(`${renderProgressBar(pct, 10, theme)} ${data.turnCount}/${data.maxTurns} turns`);
  }

  if (data.tokensUsed !== undefined) {
    const tokenColor = tokens ? tokens['status.tokens'] : chalk.gray;
    parts.push(tokenColor(`${formatTokenCount(data.tokensUsed)} tokens`));
  }

  if (data.sessionStartTime) {
    const durationColor = tokens ? tokens['status.duration'] : chalk.gray;
    parts.push(durationColor(formatDuration(Date.now() - data.sessionStartTime)));
  }

  if (parts.length === 0) return '';

  const width = process.stdout.columns || 80;
  const separator = chalk.gray(' | ');
  const content = parts.join(separator);
  const plainLen = content.replace(/\x1B\[[0-9;]*m/g, '').length;
  const padding = Math.max(0, width - plainLen - 4);

  return chalk.gray('─'.repeat(width)) + '\n' +
    chalk.gray('│') + ' ' + content + ' '.repeat(padding) + ' ' + chalk.gray('│');
}
