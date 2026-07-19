/**
 * Tests for the command palette filtering logic (Command Palette feature).
 *
 * The Ink component itself is not rendered (the vitest env has no React
 * renderer); instead we exercise the pure `filterCommands` helper that backs
 * it — case-insensitive matching over label + keywords, empty-query passthrough
 * and running the selected command.
 */

import { describe, it, expect, vi } from 'vitest';
import { filterCommands, type CommandItem } from '../../src/ui/components/CommandPalette';

function cmd(id: string, label: string, keywords?: string): CommandItem {
  return { id, label, keywords, run: vi.fn() };
}

const COMMANDS: CommandItem[] = [
  cmd('help', 'Help', '/help ?'),
  cmd('clear', 'Clear conversation', '/clear'),
  cmd('mode', 'Toggle mode', '/mode build plan'),
  cmd('sidebar', 'Toggle Sidebar'),
  cmd('files', 'File Picker', '@ attachment'),
];

describe('filterCommands', () => {
  it('returns the full list unchanged for an empty query', () => {
    expect(filterCommands(COMMANDS, '')).toHaveLength(COMMANDS.length);
    expect(filterCommands(COMMANDS, '   ')).toHaveLength(COMMANDS.length);
  });

  it('matches on the visible label, case-insensitively', () => {
    const out = filterCommands(COMMANDS, 'toggle');
    expect(out.map((c) => c.id)).toEqual(['mode', 'sidebar']);
  });

  it('matches on keywords (slash aliases) not shown in the label', () => {
    expect(filterCommands(COMMANDS, '/clear').map((c) => c.id)).toEqual(['clear']);
    expect(filterCommands(COMMANDS, 'attachment').map((c) => c.id)).toEqual(['files']);
  });

  it('returns an empty list when nothing matches', () => {
    expect(filterCommands(COMMANDS, 'zzz-nope')).toHaveLength(0);
  });

  it('preserves original ordering of the surviving commands', () => {
    const out = filterCommands(COMMANDS, 'e');
    // 'e' appears in Help, Clear, Toggle mode, File Picker labels/keywords —
    // order must follow the source list.
    const ids = out.map((c) => c.id);
    const sourceIds = COMMANDS.map((c) => c.id).filter((id) => ids.includes(id));
    expect(ids).toEqual(sourceIds);
  });

  it('runs the selected command via its run callback', () => {
    const target = cmd('clear', 'Clear conversation', '/clear');
    const [match] = filterCommands([target], 'clear');
    match!.run();
    expect(target.run).toHaveBeenCalledTimes(1);
  });
});
