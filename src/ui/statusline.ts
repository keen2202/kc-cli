import chalk from 'chalk';
import { formatStatusLine } from './formatter';

export interface StatusData {
  provider?: string;
  model?: string;
  turnCount?: number;
  maxTurns?: number;
  tokensUsed?: number;
  sessionStartTime?: number;
}

let statusData: StatusData = {};
let lastRendered = '';

export function updateStatus(data: Partial<StatusData>): void {
  statusData = { ...statusData, ...data };
  renderStatus();
}

export function clearStatus(): void {
  if (lastRendered && process.stdout.isTTY) {
    process.stdout.write('\r' + ' '.repeat(lastRendered.length) + '\r');
  }
  lastRendered = '';
}

function renderStatus(): void {
  if (!process.stdout.isTTY) return;

  const sessionTime = statusData.sessionStartTime
    ? Date.now() - statusData.sessionStartTime
    : undefined;

  const line = formatStatusLine({
    provider: statusData.provider,
    model: statusData.model,
    turnCount: statusData.turnCount,
    maxTurns: statusData.maxTurns,
    tokensUsed: statusData.tokensUsed,
    sessionTime,
  });

  if (line && line !== lastRendered) {
    clearStatus();
    process.stdout.write(chalk.dim(line));
    lastRendered = line;
  }
}
