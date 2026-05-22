/**
 * CommandPalette — Ctrl+K command palette for quick actions.
 *
 * Supports:
 * - Fuzzy search for commands
 * - Model/provider switching
 * - Permission mode switching
 * - Clear conversation, help, exit
 *
 * Architecture: chalk-based string rendering for readline TUI.
 */

import chalk from 'chalk';

// Pre-compiled regex for ANSI escape stripping (reused across render calls)
const ANSI_STRIP_REGEX = /\x1B\[[0-9;]*m/g;

// ─── Types ───

/** A single palette command. */
export interface PaletteCommand {
  /** Unique command id */
  id: string;
  /** Display label */
  label: string;
  /** Description shown when highlighted */
  description: string;
  /** Category grouping */
  category: string;
  /** Keyboard shortcut hint */
  shortcut?: string;
  /** Optional sub-commands (for model/provider selection) */
  subCommands?: PaletteCommand[];
}

/** State of the command palette. */
export interface PaletteState {
  /** Whether the palette is open */
  open: boolean;
  /** Current search query */
  query: string;
  /** Currently highlighted index */
  selectedIndex: number;
  /** All registered commands */
  commands: PaletteCommand[];
  /** Whether showing sub-commands (e.g., model list) */
  subMode: boolean;
  /** Parent command for sub-mode */
  parentCommand: PaletteCommand | null;
}

// ─── Default Commands ───

export function createDefaultCommands(): PaletteCommand[] {
  return [
    {
      id: 'model',
      label: 'Change Model',
      description: 'Switch to a different AI model',
      category: 'Model',
      shortcut: 'Alt+M',
    },
    {
      id: 'provider',
      label: 'Change Provider',
      description: 'Switch to a different AI provider',
      category: 'Model',
      shortcut: 'Alt+P',
    },
    {
      id: 'permission',
      label: 'Permission Mode',
      description: 'Change permission mode (default/bypass/plan/acceptEdits)',
      category: 'Settings',
    },
    {
      id: 'clear',
      label: 'Clear Conversation',
      description: 'Reset the current chat session',
      category: 'Session',
      shortcut: 'Ctrl+L',
    },
    {
      id: 'help',
      label: 'Show Help',
      description: 'Display available commands and shortcuts',
      category: 'Help',
      shortcut: 'F1',
    },
    {
      id: 'exit',
      label: 'Exit',
      description: 'Quit kc-cli',
      category: 'Session',
      shortcut: 'Ctrl+D',
    },
  ];
}

// ─── State Management ───

export function createPaletteState(): PaletteState {
  return {
    open: false,
    query: '',
    selectedIndex: 0,
    commands: createDefaultCommands(),
    subMode: false,
    parentCommand: null,
  };
}

/**
 * Filter commands by fuzzy matching the query against labels and descriptions.
 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
  if (!query.trim()) return commands;

  const lowerQuery = query.toLowerCase().trim();
  const terms = lowerQuery.split(/\s+/);

  return commands.filter(cmd => {
    // Single haystack string for all searchable fields (one allocation per command)
    const haystack = `${cmd.label} ${cmd.description} ${cmd.category} ${cmd.id}`.toLowerCase();

    return terms.every(term => haystack.includes(term));
  });
}

// ─── Rendering ───

/**
 * Render the command palette overlay.
 */
export function renderCommandPalette(
  state: PaletteState,
  options: { maxWidth?: number; maxHeight?: number } = {}
): string {
  const maxWidth = options.maxWidth ?? 60;
  const maxHeight = options.maxHeight ?? 12;
  const lines: string[] = [];

  const filtered = filterCommands(state.commands, state.query);
  const clampedIdx = Math.max(0, Math.min(state.selectedIndex, Math.max(0, filtered.length - 1)));

  // Header
  const headerText = state.subMode && state.parentCommand
    ? `Command Palette › ${state.parentCommand.label}`
    : 'Command Palette';
  lines.push(
    chalk.cyan.bold('┌─ ') +
    chalk.cyan.bold(headerText) +
    chalk.gray(' ─' + '─'.repeat(Math.max(0, maxWidth - headerText.length - 8)) + '┐')
  );

  // Search bar
  const searchPrefix = chalk.gray('│ ') + chalk.yellow('> ');
  const searchSuffix = chalk.dim(state.query ? '' : 'Type to search...');
  const searchCursor = '_';
  const searchVisible = state.query + (state.open ? searchCursor : '');
  const searchPadding = Math.max(0, maxWidth - state.query.length - 10);
  lines.push(
    `${searchPrefix}${chalk.white(searchVisible)}${searchSuffix}${' '.repeat(searchPadding)}${chalk.gray('│')}`
  );

  // Separator
  lines.push(chalk.gray('├' + '─'.repeat(maxWidth) + '┤'));

  // Command list
  const listStart = 0;
  const listEnd = Math.min(filtered.length, maxHeight);
  const showCount = listEnd - listStart;

  if (filtered.length === 0) {
    lines.push(
      chalk.gray('│ ') + chalk.dim('No matching commands') + ' '.repeat(maxWidth - 24) + chalk.gray('│')
    );
  } else {
    for (let i = listStart; i < listEnd; i++) {
      const cmd = filtered[i];
      if (!cmd) continue;
      const isSelected = i === clampedIdx;

      const marker = isSelected ? chalk.cyan.bold('❯ ') : '  ';
      const label = isSelected ? chalk.white.bold(cmd.label) : chalk.dim(cmd.label);
      const shortcut = cmd.shortcut ? chalk.gray(` [${cmd.shortcut}]`) : '';
      const desc = isSelected ? chalk.gray(` — ${cmd.description}`) : '';

      const row = `${marker}${label}${desc}${shortcut}`;
      const plainRow = row.replace(ANSI_STRIP_REGEX, '');
      const padding = Math.max(0, maxWidth - plainRow.length + 1);

      lines.push(chalk.gray('│') + ' ' + row + ' '.repeat(padding) + chalk.gray('│'));
    }
  }

  // Fill remaining
  for (let i = showCount; i < maxHeight; i++) {
    lines.push(chalk.gray('│') + ' '.repeat(maxWidth + 1) + chalk.gray('│'));
  }

  // Footer
  lines.push(chalk.gray('├' + '─'.repeat(maxWidth) + '┤'));
  lines.push(
    chalk.gray('│ ') +
    chalk.dim('↑↓ Navigate  Enter Select  Esc Close  Type to search') +
    ' '.repeat(Math.max(0, maxWidth - 54)) +
    chalk.gray('│')
  );
  lines.push(chalk.gray('└' + '─'.repeat(maxWidth) + '┘'));

  return lines.join('\n');
}

// ─── Navigation ───

/**
 * Move selection up.
 */
export function paletteMoveUp(state: PaletteState): void {
  const filtered = filterCommands(state.commands, state.query);
  if (filtered.length === 0) return;
  state.selectedIndex = (state.selectedIndex - 1 + filtered.length) % filtered.length;
}

/**
 * Move selection down.
 */
export function paletteMoveDown(state: PaletteState): void {
  const filtered = filterCommands(state.commands, state.query);
  if (filtered.length === 0) return;
  state.selectedIndex = (state.selectedIndex + 1) % filtered.length;
}

/**
 * Get the currently selected command.
 */
export function paletteGetSelected(state: PaletteState): PaletteCommand | null {
  const filtered = filterCommands(state.commands, state.query);
  const idx = Math.max(0, Math.min(state.selectedIndex, Math.max(0, filtered.length - 1)));
  return filtered[idx] ?? null;
}

/**
 * Close the palette and reset state.
 */
export function paletteClose(state: PaletteState): void {
  state.open = false;
  state.query = '';
  state.selectedIndex = 0;
  state.subMode = false;
  state.parentCommand = null;
}
