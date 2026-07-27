import chalk from 'chalk';
import type { Theme } from '../theme';

// LIVE runtime helpers (T7 triage): renderToolCallCard/renderToolCallCompact
// are used by ChatMessagesView. The ToolCallData contract lives in
// view-protocol — import it from there, never from this file.
import type { ToolCallData } from '../view-protocol';

/** Rendering options for the chat tool card. */
export interface ToolCallCardOptions {
  /** When true, show the full tool output (capped); default is a collapsed preview. */
  expanded?: boolean;
}

/** Collapsed cards preview at most this many output lines. */
const PREVIEW_LINES = 2;
/** Expanded cards cap the output to avoid flooding the terminal. */
const EXPANDED_MAX_LINES = 200;

export function renderToolCallCard(
  tc: ToolCallData,
  theme?: Theme,
  options?: ToolCallCardOptions,
): string {
  const tokens = theme?.resolve();
  const expanded = options?.expanded ?? false;

  const statusIcon = tc.status === 'running'
    ? (tokens ? tokens['tool.running']('⠋') : chalk.yellow('⠋'))
    : tc.status === 'completed'
      ? (tokens ? tokens['tool.success']('✓') : chalk.green('✓'))
      : (tokens ? tokens['tool.failed']('✗') : chalk.red('✗'));

  const elapsed = tc.startTime && tc.endTime
    ? chalk.gray(` (${((tc.endTime - tc.startTime) / 1000).toFixed(1)}s)`) : '';

  const nameColor = tokens ? tokens['tool.name'] : chalk.bold;
  const inputSummary = tc.input ? chalk.dim(` · ${tc.input}`) : '';

  const outputLines = tc.status === 'completed' && tc.output
    ? tc.output.replace(/\r\n/g, '\n').split('\n')
    : [];

  // Header: icon + name + input summary + elapsed, plus a collapse hint when
  // there is hidden output to expand.
  let hint = '';
  if (outputLines.length > 0 && !expanded && outputLines.length > PREVIEW_LINES) {
    hint = chalk.dim(` · ${outputLines.length} lines (Ctrl+O to expand)`);
  }

  const lines: string[] = [];
  lines.push(`${statusIcon} ${nameColor(tc.toolName)}${inputSummary}${elapsed}${hint}`);

  if (tc.status === 'failed' && tc.output) {
    const truncated = tc.output.length > 200 ? tc.output.slice(0, 200) + '...' : tc.output;
    const errorColor = tokens ? tokens['error.text'] : chalk.red;
    lines.push(errorColor(`  ${truncated}`));
  } else if (outputLines.length > 0) {
    if (expanded) {
      const shown = outputLines.slice(0, EXPANDED_MAX_LINES);
      for (const line of shown) lines.push(chalk.dim(`  ${line}`));
      if (outputLines.length > EXPANDED_MAX_LINES) {
        lines.push(chalk.dim(`  … ${outputLines.length - EXPANDED_MAX_LINES} more lines truncated`));
      }
    } else {
      for (const line of outputLines.slice(0, PREVIEW_LINES)) {
        lines.push(chalk.dim(`  ${line}`));
      }
    }
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
