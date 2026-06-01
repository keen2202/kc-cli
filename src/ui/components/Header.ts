import chalk from 'chalk';
import type { Theme } from '../theme';

export interface HeaderProps {
  provider: string;
  model: string;
  sessionId: string;
  width: number;
  theme: Theme;
}

export interface RenderResult {
  lines: string[];
  cursorX?: number;
  cursorY?: number;
  needsInput?: boolean;
}

export function renderHeader(props: HeaderProps): RenderResult {
  const tokens = props.theme.resolve();
  const borderColor = tokens['overlay.border'];
  const header = tokens['header.brand']('kc ') +
    chalk.gray.dim('v2.0') +
    chalk.gray(' · ') +
    tokens['header.model'](`${props.provider}/${props.model}`) +
    chalk.gray(' · ') +
    chalk.gray.dim(`Session #${props.sessionId}`);

  const line = `${borderColor('│')} ${header.padEnd(props.width - 4)} ${borderColor('│')}`;
  const top = borderColor('┌' + '─'.repeat(props.width - 2) + '┐');

  return { lines: [top, line] };
}
