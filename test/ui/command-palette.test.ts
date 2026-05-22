/**
 * Tests for CommandPalette component.
 *
 * Covers:
 * - Palette state creation and management
 * - Command filtering (fuzzy search)
 * - Palette navigation (up/down)
 * - Palette rendering
 * - Default commands
 */

import { describe, it, expect } from 'vitest';
import {
  createPaletteState,
  createDefaultCommands,
  filterCommands,
  renderCommandPalette,
  paletteMoveUp,
  paletteMoveDown,
  paletteGetSelected,
  paletteClose,
  type PaletteState,
} from '../../src/ui/components/CommandPalette';

describe('CommandPalette — State', () => {
  it('creates default palette state', () => {
    const state = createPaletteState();
    expect(state.open).toBe(false);
    expect(state.query).toBe('');
    expect(state.selectedIndex).toBe(0);
    expect(state.subMode).toBe(false);
    expect(state.commands.length).toBeGreaterThan(0);
  });

  it('paletteClose resets state', () => {
    const state = createPaletteState();
    state.open = true;
    state.query = 'model';
    state.selectedIndex = 5;

    paletteClose(state);
    expect(state.open).toBe(false);
    expect(state.query).toBe('');
    expect(state.selectedIndex).toBe(0);
    expect(state.subMode).toBe(false);
    expect(state.parentCommand).toBeNull();
  });
});

describe('CommandPalette — Default Commands', () => {
  it('includes all required commands', () => {
    const commands = createDefaultCommands();
    const ids = commands.map(c => c.id);
    expect(ids).toContain('model');
    expect(ids).toContain('provider');
    expect(ids).toContain('permission');
    expect(ids).toContain('clear');
    expect(ids).toContain('help');
    expect(ids).toContain('exit');
  });

  it('all commands have labels and descriptions', () => {
    const commands = createDefaultCommands();
    for (const cmd of commands) {
      expect(cmd.label).toBeTruthy();
      expect(cmd.description).toBeTruthy();
      expect(cmd.category).toBeTruthy();
    }
  });

  it('each command has a unique id', () => {
    const commands = createDefaultCommands();
    const ids = new Set(commands.map(c => c.id));
    expect(ids.size).toBe(commands.length);
  });
});

describe('CommandPalette — Filter', () => {
  it('returns all commands for empty query', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, '');
    expect(result).toHaveLength(commands.length);
  });

  it('filters by label match', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, 'model');
    expect(result.length).toBeGreaterThanOrEqual(2); // 'Change Model' + 'Change Provider' (desc contains model)
  });

  it('filters by description match', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, 'quit');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.id).toBe('exit');
  });

  it('filters by category match', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, 'session');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.every(c => c.category === 'Session')).toBe(true);
  });

  it('returns empty for no match', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, 'xyzzy_nonexistent');
    expect(result).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const commands = createDefaultCommands();
    const resultA = filterCommands(commands, 'MODEL');
    const resultB = filterCommands(commands, 'model');
    expect(resultA.length).toBe(resultB.length);
    expect(resultA.length).toBeGreaterThan(0);
  });

  it('supports multi-term search (AND)', () => {
    const commands = createDefaultCommands();
    // 'clear conversation' should match 'Clear Conversation' (both terms in label)
    const result = filterCommands(commands, 'clear conversation');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0]!.id).toBe('clear');
  });
});

describe('CommandPalette — Navigation', () => {
  it('moves selection down', () => {
    const state = createPaletteState();
    state.selectedIndex = 0;
    paletteMoveDown(state);
    expect(state.selectedIndex).toBe(1);
  });

  it('moves selection up', () => {
    const state = createPaletteState();
    state.selectedIndex = 2;
    paletteMoveUp(state);
    expect(state.selectedIndex).toBe(1);
  });

  it('wraps around at bottom', () => {
    const state = createPaletteState();
    const count = state.commands.length;
    state.selectedIndex = count - 1;
    paletteMoveDown(state);
    expect(state.selectedIndex).toBe(0);
  });

  it('wraps around at top', () => {
    const state = createPaletteState();
    state.selectedIndex = 0;
    paletteMoveUp(state);
    expect(state.selectedIndex).toBe(state.commands.length - 1);
  });

  it('getSelected returns null when no commands match', () => {
    const state = createPaletteState();
    state.query = 'xyzzy_nonexistent';
    const selected = paletteGetSelected(state);
    expect(selected).toBeNull();
  });

  it('getSelected returns first filtered command when results exist', () => {
    const state = createPaletteState();
    state.query = 'exit';
    const selected = paletteGetSelected(state);
    expect(selected).not.toBeNull();
    expect(selected!.id).toBe('exit');
  });

  it('navigation works within filtered results', () => {
    const state = createPaletteState();
    state.query = 'exit';
    // 'exit' should match exactly 1 command
    const filtered = filterCommands(state.commands, 'exit');
    expect(filtered.length).toBe(1);

    state.selectedIndex = 0;
    paletteMoveDown(state);
    // With 1 result, wraps back to 0
    expect(state.selectedIndex).toBe(0);
  });
});

describe('CommandPalette — Rendering', () => {
  it('renders palette header', () => {
    const state = createPaletteState();
    state.open = true;
    const output = renderCommandPalette(state, { maxWidth: 60 });
    expect(output).toContain('Command Palette');
  });

  it('renders search bar', () => {
    const state = createPaletteState();
    state.open = true;
    state.query = 'model';
    const output = renderCommandPalette(state, { maxWidth: 60 });
    expect(output).toContain('model');
  });

  it('shows navigation help', () => {
    const state = createPaletteState();
    state.open = true;
    const output = renderCommandPalette(state, { maxWidth: 60 });
    expect(output).toContain('Navigate');
    expect(output).toContain('Select');
    expect(output).toContain('Close');
  });

  it('shows no-results message when query has no match', () => {
    const state = createPaletteState();
    state.query = 'xyzzy_nonexistent';
    const output = renderCommandPalette(state, { maxWidth: 60 });
    expect(output).toContain('No matching commands');
  });

  it('renders commands with highlights', () => {
    const state = createPaletteState();
    state.open = true;
    state.query = 'exit';
    const output = renderCommandPalette(state, { maxWidth: 60 });
    expect(output).toContain('Exit');
  });

  it('renders sub-mode header when in subMode', () => {
    const state = createPaletteState();
    state.subMode = true;
    state.parentCommand = { id: 'model', label: 'Change Model', description: '', category: 'Model' };
    state.open = true;
    const output = renderCommandPalette(state, { maxWidth: 60 });
    expect(output).toContain('Change Model');
  });

  it('renders search placeholder when no query', () => {
    const state = createPaletteState();
    state.open = true;
    state.query = '';
    const output = renderCommandPalette(state, { maxWidth: 60 });
    expect(output).toContain('Type to search');
  });

  it('renders search cursor when open', () => {
    const state = createPaletteState();
    state.open = true;
    state.query = 'test';
    const output = renderCommandPalette(state, { maxWidth: 60 });
    expect(output).toContain('test_');
  });

  it('renders commands with shortcuts', () => {
    const state = createPaletteState();
    state.open = true;
    state.query = 'model';
    const output = renderCommandPalette(state, { maxWidth: 80 });
    // Model command has Alt+M shortcut
    expect(output).toContain('Alt+M');
  });

  it('fills empty rows to maintain height', () => {
    const state = createPaletteState();
    state.open = true;
    state.query = 'xyzzy_nonexistent';
    const output = renderCommandPalette(state, { maxWidth: 60, maxHeight: 8 });
    const lines = output.split('\n');
    // Should have at least maxHeight + header/footer lines
    expect(lines.length).toBeGreaterThanOrEqual(8);
  });

  it('renders with custom maxHeight', () => {
    const state = createPaletteState();
    state.open = true;
    const output = renderCommandPalette(state, { maxWidth: 60, maxHeight: 5 });
    expect(output).toContain('Command Palette');
  });
});

describe('CommandPalette — Filter Edge Cases', () => {
  it('filters by command id', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, 'clear');
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result.some(c => c.id === 'clear')).toBe(true);
  });

  it('handles whitespace-only query', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, '   ');
    expect(result).toHaveLength(commands.length);
  });

  it('handles query with extra spaces', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, '  model  ');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('filters with partial match on category', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, 'help');
    expect(result.some(c => c.category === 'Help')).toBe(true);
  });

  it('returns empty for special characters in query', () => {
    const commands = createDefaultCommands();
    const result = filterCommands(commands, '@#$%');
    expect(result).toHaveLength(0);
  });
});
