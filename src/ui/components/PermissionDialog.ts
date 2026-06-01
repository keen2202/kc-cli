import chalk from 'chalk';
import type { Theme } from '../theme';

export type PermissionDecision = 'allow' | 'allow_always' | 'deny';

export interface PermissionDialogProps {
  toolName: string;
  inputSummary?: string;
  theme: Theme;
}

export function renderPermissionDialog(props: PermissionDialogProps): string {
  const tokens = props.theme.resolve();
  const borderColor = tokens['overlay.border'];
  const selectedColor = tokens['overlay.selected'];
  const maxWidth = 60;

  const lines: string[] = [];
  lines.push(
    selectedColor('┌─ ') +
    selectedColor('Permission Required') +
    borderColor(' ─' + '─'.repeat(maxWidth - 22) + '┐')
  );

  lines.push(borderColor('│') + ' ' + chalk.white(`Tool: ${props.toolName}`) + ' '.repeat(Math.max(0, maxWidth - props.toolName.length - 8)) + borderColor('│'));

  if (props.inputSummary) {
    const truncated = props.inputSummary.length > maxWidth - 4
      ? props.inputSummary.slice(0, maxWidth - 7) + '...'
      : props.inputSummary;
    lines.push(borderColor('│') + ' ' + chalk.dim(truncated) + ' '.repeat(Math.max(0, maxWidth - truncated.length - 4)) + borderColor('│'));
  }

  lines.push(borderColor('├' + '─'.repeat(maxWidth) + '┤'));
  const successColor = tokens ? tokens['tool.success'] : chalk.green;
  const primaryColor = tokens ? tokens['status.model'] : chalk.cyan;
  const errorColor = tokens ? tokens['error.text'] : chalk.red;
  lines.push(
    borderColor('│ ') +
    successColor.bold('[Y]') + chalk.dim(' Allow Once  ') +
    primaryColor.bold('[A]') + chalk.dim(' Allow Always  ') +
    errorColor.bold('[N]') + chalk.dim(' Deny') +
    ' '.repeat(Math.max(0, maxWidth - 42)) +
    borderColor('│')
  );
  lines.push(borderColor('└' + '─'.repeat(maxWidth) + '┘'));

  return lines.join('\n');
}

export function resolvePermissionKey(key: string): PermissionDecision | null {
  switch (key.toLowerCase()) {
    case 'y': return 'allow';
    case 'a': return 'allow_always';
    case 'n': return 'deny';
    default: return null;
  }
}
