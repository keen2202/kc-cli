import chalk from 'chalk';
import type { Theme } from '../theme';
import type { Keybinding } from '../keybinding-manager';

export interface HelpPanelProps {
  commands: Array<{ name: string; description: string }>;
  keybindings: Keybinding[];
  theme: Theme;
}

export function renderHelpPanel(props: HelpPanelProps): string {
  const tokens = props.theme.resolve();
  const borderColor = tokens['overlay.border'];
  const headerColor = tokens['overlay.selected'];
  const maxWidth = 70;

  const lines: string[] = [];
  lines.push(
    headerColor('┌─ ') +
    headerColor('Help') +
    borderColor(' ─' + '─'.repeat(maxWidth - 10) + '┐')
  );

  // Commands section
  lines.push(borderColor('│') + ' ' + chalk.white.bold('Commands') + ' '.repeat(maxWidth - 11) + borderColor('│'));
  lines.push(borderColor('│') + ' ' + chalk.gray('─'.repeat(maxWidth - 4)) + ' ' + borderColor('│'));

  for (const cmd of props.commands) {
    const name = (tokens ? tokens['status.model'] : chalk.cyan)(cmd.name.padEnd(16));
    const desc = chalk.dim(cmd.description);
    const row = `${name}${desc}`;
    const plainLen = cmd.name.length + 16 + cmd.description.length;
    const padding = Math.max(0, maxWidth - plainLen - 2);
    lines.push(borderColor('│') + ' ' + row + ' '.repeat(padding) + borderColor('│'));
  }

  // Keybindings section
  lines.push(borderColor('│') + ' '.repeat(maxWidth - 2) + borderColor('│'));
  lines.push(borderColor('│') + ' ' + chalk.white.bold('Keybindings') + ' '.repeat(maxWidth - 14) + borderColor('│'));
  lines.push(borderColor('│') + ' ' + chalk.gray('─'.repeat(maxWidth - 4)) + ' ' + borderColor('│'));

  for (const kb of props.keybindings) {
    const key = (tokens ? tokens['warning.text'] : chalk.yellow)(kb.key.padEnd(16));
    const desc = chalk.dim(kb.description);
    const row = `${key}${desc}`;
    const plainLen = kb.key.length + 16 + kb.description.length;
    const padding = Math.max(0, maxWidth - plainLen - 2);
    lines.push(borderColor('│') + ' ' + row + ' '.repeat(padding) + borderColor('│'));
  }

  // Footer
  lines.push(borderColor('├' + '─'.repeat(maxWidth) + '┤'));
  lines.push(
    borderColor('│ ') +
    chalk.dim('Press Esc to close') +
    ' '.repeat(maxWidth - 21) +
    borderColor('│')
  );
  lines.push(borderColor('└' + '─'.repeat(maxWidth) + '┘'));

  return lines.join('\n');
}
