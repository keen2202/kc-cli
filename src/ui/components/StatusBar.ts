// LEGACY (T7 triage): string-rendering status bar kept only for its unit
// tests. The live status bar is the ink component in StatusBarView.tsx — do
// not wire this back into the render path.
import chalk from 'chalk';
import type { Theme } from '../theme';

interface StatusBarData {
  provider?: string;
  model?: string;
  turnCount?: number;
  maxTurns?: number;
  tokensUsed?: number;
  sessionStartTime?: number;
  isStreaming?: boolean;
  mode?: 'idle' | 'streaming' | 'overlay' | 'steer';
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

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
let spinnerFrame = 0;

export function renderStatusBar(data: StatusBarData, theme?: Theme): string {
  const tokens = theme?.resolve();
  const leftParts: string[] = [];
  const rightParts: string[] = [];

  // Mode indicator
  const mode = data.isStreaming ? 'streaming' : (data.mode || 'idle');
  const modeLabels: Record<string, string> = {
    idle: chalk.gray('○ idle'),
    streaming: chalk.yellow('◉ streaming'),
    overlay: chalk.magenta('◇ overlay'),
    steer: chalk.blue('◆ steer'),
  };
  leftParts.push(modeLabels[mode] || modeLabels.idle);

  // Streaming spinner
  if (data.isStreaming) {
    spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
    const spinnerColor = tokens ? tokens['status.tokens'] : chalk.yellow;
    leftParts.push(spinnerColor(`${SPINNER_FRAMES[spinnerFrame]} Generating...`));
  }

  // Track whether we have any actual data (beyond mode indicator)
  let hasData = false;

  // Provider/Model
  if (data.provider && data.model) {
    const modelColor = tokens ? tokens['status.model'] : chalk.cyan;
    leftParts.push(modelColor(`${data.provider}/${data.model}`));
    hasData = true;
  }

  // Turn progress
  if (data.turnCount !== undefined && data.maxTurns !== undefined) {
    const pct = Math.round((data.turnCount / data.maxTurns) * 100);
    leftParts.push(`${renderProgressBar(pct, 10, theme)} ${data.turnCount}/${data.maxTurns}`);
    hasData = true;
  }

  // Right-aligned: tokens
  if (data.tokensUsed !== undefined) {
    const tokenColor = tokens ? tokens['status.tokens'] : chalk.gray;
    rightParts.push(tokenColor(`${formatTokenCount(data.tokensUsed)} tokens`));
    hasData = true;
  }

  // Right-aligned: duration
  if (data.sessionStartTime) {
    const durationColor = tokens ? tokens['status.duration'] : chalk.gray;
    rightParts.push(durationColor(formatDuration(Date.now() - data.sessionStartTime)));
    hasData = true;
  }

  if (!hasData) return '';

  const width = process.stdout.columns || 80;
  const separator = chalk.gray(' | ');
  const leftContent = leftParts.join(separator);
  const rightContent = rightParts.join(separator);
  const leftPlainLen = leftContent.replace(/\x1B\[[0-9;]*m/g, '').length;
  const rightPlainLen = rightContent.replace(/\x1B\[[0-9;]*m/g, '').length;
  const middlePadding = Math.max(1, width - leftPlainLen - rightPlainLen - 6);

  return chalk.gray('─'.repeat(width)) + '\n' +
    chalk.gray('│') + ' ' + leftContent + ' '.repeat(middlePadding) + rightContent + ' ' + chalk.gray('│');
}
