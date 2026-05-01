import chalk from 'chalk';

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

function renderProgressBar(percent: number, width: number = 10): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

export function renderStatusBar(data: StatusBarData): string {
  const parts: string[] = [];

  if (data.provider && data.model) {
    parts.push(chalk.cyan(`${data.provider}/${data.model}`));
  }

  if (data.turnCount !== undefined && data.maxTurns !== undefined) {
    const pct = Math.round((data.turnCount / data.maxTurns) * 100);
    parts.push(`${renderProgressBar(pct)} ${data.turnCount}/${data.maxTurns} turns`);
  }

  if (data.tokensUsed !== undefined) {
    parts.push(chalk.gray(`${formatTokenCount(data.tokensUsed)} tokens`));
  }

  if (data.sessionStartTime) {
    parts.push(chalk.gray(formatDuration(Date.now() - data.sessionStartTime)));
  }

  if (parts.length === 0) return '';

  const width = process.stdout.columns || 80;
  const content = parts.join(chalk.gray(' | '));
  const plainLen = content.replace(/\x1B\[[0-9;]*m/g, '').length;
  const padding = Math.max(0, width - plainLen - 4);

  return chalk.gray('─'.repeat(width)) + '\n' +
    chalk.gray('│') + ' ' + content + ' '.repeat(padding) + ' ' + chalk.gray('│');
}
