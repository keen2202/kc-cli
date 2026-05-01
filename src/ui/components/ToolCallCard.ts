import chalk from 'chalk';

export interface ToolCallData {
  toolName: string;
  input?: string;
  output?: string;
  status: 'running' | 'completed' | 'failed';
  startTime?: number;
  endTime?: number;
}

export function renderToolCallCard(tc: ToolCallData): string {
  const statusIcon = tc.status === 'running' ? chalk.yellow('⠋') :
    tc.status === 'completed' ? chalk.green('✓') : chalk.red('✗');

  const elapsed = tc.startTime && tc.endTime ?
    chalk.gray(` (${((tc.endTime - tc.startTime) / 1000).toFixed(1)}s)`) : '';

  const lines: string[] = [];
  lines.push(`${statusIcon} ${chalk.bold(tc.toolName)}${elapsed}`);

  if (tc.status === 'failed' && tc.output) {
    const truncated = tc.output.length > 200 ? tc.output.slice(0, 200) + '...' : tc.output;
    lines.push(chalk.red(`  ${truncated}`));
  }

  return lines.join('\n');
}

export function renderToolCallCompact(tc: ToolCallData): string {
  const icon = tc.status === 'running' ? chalk.yellow('⠋') :
    tc.status === 'completed' ? chalk.green('✓') : chalk.red('✗');
  return `${icon} ${tc.toolName}`;
}
