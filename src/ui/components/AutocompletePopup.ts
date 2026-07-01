import chalk from 'chalk';
import type { Theme } from '../theme';

export interface AutocompleteItem {
  label: string;
  description: string;
  type: 'tool' | 'file' | 'command' | 'agent';
}

export interface AutocompleteState {
  visible: boolean;
  query: string;
  items: AutocompleteItem[];
  selectedIndex: number;
}

export function createAutocompleteState(): AutocompleteState {
  return { visible: false, query: '', items: [], selectedIndex: 0 };
}

export function autocompleteMoveUp(state: AutocompleteState): void {
  if (state.selectedIndex > 0) state.selectedIndex--;
}

export function autocompleteMoveDown(state: AutocompleteState): void {
  if (state.selectedIndex < state.items.length - 1) state.selectedIndex++;
}

export function autocompleteGetSelected(state: AutocompleteState): AutocompleteItem | null {
  return state.items[state.selectedIndex] ?? null;
}

export function filterAutocompleteItems(query: string, allItems: AutocompleteItem[]): AutocompleteItem[] {
  if (!query || query.length < 2) return [];
  const lower = query.toLowerCase();
  return allItems
    .filter(item => item.label.toLowerCase().includes(lower))
    .slice(0, 20);
}

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export function buildAutocompleteItems(
  tools: string[],
  commands: string[],
  files: string[],
  agents: string[],
): AutocompleteItem[] {
  return [
    ...commands.map(c => ({ label: c, description: 'Command', type: 'command' as const })),
    ...tools.map(t => ({ label: t, description: 'Tool', type: 'tool' as const })),
    ...files.map(f => ({ label: f, description: 'File', type: 'file' as const })),
    ...agents.map(a => ({ label: a, description: 'Agent', type: 'agent' as const })),
  ];
}

export function renderAutocompletePopup(
  state: AutocompleteState,
  maxWidth: number,
  theme?: Theme,
): string[] {
  if (!state.visible || state.items.length === 0) return [];

  const tokens = theme?.resolve();
  const border = tokens ? tokens['overlay.border'] : chalk.gray;
  const highlight = tokens ? tokens['overlay.selected'] : chalk.bgCyan.black;
  const muted = tokens ? tokens['chat.system'] : chalk.gray;
  const primary = tokens ? tokens['tool.name'] : chalk.white;

  const typeIcons: Record<string, string> = {
    command: '/',
    tool: '🔧',
    file: '@',
    agent: '🤖',
  };

  const lines: string[] = [];
  const popupWidth = Math.min(maxWidth - 4, 50);

  // Top border
  const title = ` ${state.items.length} matches `;
  lines.push(border('┌' + title + '─'.repeat(Math.max(0, popupWidth - stripAnsi(title).length - 2)) + '┐'));

  // Items
  const maxShow = Math.min(state.items.length, 10);
  for (let i = 0; i < maxShow; i++) {
    const item = state.items[i];
    const icon = typeIcons[item.type] || ' ';
    let line = ` ${icon} ${item.label}`;
    if (item.description) {
      line += ' ' + muted(item.description);
    }
    // Pad to width
    const plainLen = stripAnsi(line).length;
    if (plainLen < popupWidth) {
      line += ' '.repeat(popupWidth - plainLen);
    } else {
      line = line.slice(0, popupWidth);
    }

    if (i === state.selectedIndex) {
      lines.push(border('│') + highlight(' ' + stripAnsi(line).slice(0, popupWidth - 1)) + border('│'));
    } else {
      lines.push(border('│') + primary(line) + border('│'));
    }
  }

  // If there are more items than shown
  if (state.items.length > maxShow) {
    const remaining = state.items.length - maxShow;
    lines.push(border('│') + muted(` ... and ${remaining} more`) + ' '.repeat(Math.max(0, popupWidth - (14 + String(remaining).length))) + border('│'));
  }

  // Bottom border
  lines.push(border('└' + '─'.repeat(popupWidth) + '┘'));

  return lines;
}
