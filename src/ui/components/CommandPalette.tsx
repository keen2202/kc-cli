// Command palette overlay — fuzzy-ish filterable command list.
//
// Opened via Ctrl+K. Renders a filterable list of commands (slash commands +
// UI actions). Navigation with ↑/↓, Enter to run the highlighted command, Esc
// to close. The pure `filterCommands` helper is exported for unit testing
// without rendering the Ink tree.

import React, { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useFocusLayer } from '../hooks/useFocusLayer';
import type { KeypressEvent } from '../keypress';

export interface CommandItem {
  id: string;
  label: string;
  /** Optional keywords to broaden matching (e.g. slash aliases). */
  keywords?: string;
  run: () => void;
}

interface CommandPaletteProps {
  commands: CommandItem[];
  onClose: () => void;
}

const MAX_VISIBLE = 10;

/**
 * Case-insensitive substring filter over label + keywords. An empty query
 * returns the full list unchanged (preserving order).
 */
export function filterCommands(commands: CommandItem[], query: string): CommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => {
    const haystack = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
    return haystack.includes(q);
  });
}

export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const { colors } = useTheme();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const clampedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1));

  // Focus layer: the palette owns the keyboard while mounted; ESC closes it
  // via the stack's unified escape semantics.
  useFocusLayer({
    id: 'palette',
    onKey: (event: KeypressEvent) => {
      if (event.name === 'return') {
        const cmd = filtered[clampedIndex];
        if (cmd) {
          onClose();
          cmd.run();
        }
        return true;
      }
      if (event.name === 'up') {
        setSelectedIndex((i) => Math.max(0, Math.min(i, filtered.length - 1) - 1));
        return true;
      }
      if (event.name === 'down') {
        setSelectedIndex((i) => Math.min(filtered.length - 1, i + 1));
        return true;
      }
      if (event.name === 'backspace' || event.name === 'delete') {
        setQuery((q) => q.slice(0, -1));
        setSelectedIndex(0);
        return true;
      }
      // Printable characters extend the query; everything else is swallowed.
      if (event.isPrintable) {
        setQuery((q) => q + event.name);
        setSelectedIndex(0);
      }
      return true;
    },
    onEscape: () => {
      onClose();
      return true;
    },
  });

  const visible = filtered.slice(0, MAX_VISIBLE);

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="single"
      borderColor={colors.border}
      padding={1}
      width={54}
    >
      <Box marginBottom={1}>
        <Text bold color={colors.primary}>Command Palette</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color={colors.muted}>{'> '}</Text>
        <Text>{query || ''}</Text>
        {query.length === 0 && <Text color={colors.muted}>type to filter…</Text>}
      </Box>
      {visible.length === 0 ? (
        <Text color={colors.muted}>No matching commands</Text>
      ) : (
        visible.map((cmd, i) => (
          <Box key={cmd.id} flexDirection="row">
            <Text color={i === clampedIndex ? colors.primary : undefined}>
              {i === clampedIndex ? '▶ ' : '  '}
              {cmd.label}
            </Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text color={colors.muted}>↑/↓: navigate · Enter: run · Esc: close</Text>
      </Box>
    </Box>
  );
}
