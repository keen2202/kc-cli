import chalk from 'chalk';
import type { Theme } from '../theme';

// LIVE runtime helpers (T7 triage): renderToolCallCard/renderToolCallCompact
// are used by ChatMessagesView. The ToolCallData contract lives in
// view-protocol — import it from there, never from this file.
import type { ToolCallData } from '../view-protocol';

export function renderToolCallCard(tc: ToolCallData, theme?: Theme): string {
  const tokens = theme?.resolve();

  const statusIcon = tc.status === 'running'
    ? (tokens ? tokens['tool.running']('⠋') : chalk.yellow('⠋'))
    : tc.status === 'completed'
      ? (tokens ? tokens['tool.success']('✓') : chalk.green('✓'))
      : (tokens ? tokens['tool.failed']('✗') : chalk.red('✗'));

  const elapsed = tc.startTime && tc.endTime
    ? chalk.gray(` (${((tc.endTime - tc.startTime) / 1000).toFixed(1)}s)`) : '';

  const nameColor = tokens ? tokens['tool.name'] : chalk.bold;
  const lines: string[] = [];
  lines.push(`${statusIcon} ${nameColor(tc.toolName)}${elapsed}`);

  if (tc.status === 'failed' && tc.output) {
    const truncated = tc.output.length > 200 ? tc.output.slice(0, 200) + '...' : tc.output;
    const errorColor = tokens ? tokens['error.text'] : chalk.red;
    lines.push(errorColor(`  ${truncated}`));
  }

  return lines.join('\n');
}

export function renderToolCallCompact(tc: ToolCallData, theme?: Theme): string {
  const tokens = theme?.resolve();
  const icon = tc.status === 'running'
    ? (tokens ? tokens['tool.running']('⠋') : chalk.yellow('⠋'))
    : tc.status === 'completed'
      ? (tokens ? tokens['tool.success']('✓') : chalk.green('✓'))
      : (tokens ? tokens['tool.failed']('✗') : chalk.red('✗'));
  return `${icon} ${tc.toolName}`;
}
