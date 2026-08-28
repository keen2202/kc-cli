import React, { useState } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import { useFocusLayer } from '../hooks/useFocusLayer';
import type { KeypressEvent } from '../keypress';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FilePickerProps {
  files: FileItem[];
  onSelect: (filePath: string) => void;
  onCancel: () => void;
  /** Row budget from the layout policy; the file list is windowed to fit. */
  maxRows?: number;
  /** Width budget from the layout policy on narrow terminals. */
  maxWidth?: number;
}

const MAX_FILES = 20;
/** Chrome rows (border + padding + title + hint + margin). */
const CHROME_ROWS = 7;

export function FilePicker({ files, onSelect, onCancel, maxRows, maxWidth }: FilePickerProps) {
  const { colors } = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const maxItems = Math.max(1, Math.min(MAX_FILES, maxRows !== undefined ? maxRows - CHROME_ROWS : MAX_FILES));
  const maxIndex = Math.max(0, Math.min(files.length, maxItems) - 1);

  // Focus layer: the picker owns the keyboard while mounted; ESC cancels it
  // via the stack's unified escape semantics.
  useFocusLayer({
    id: 'file-picker',
    onKey: (event: KeypressEvent) => {
      if (event.name === 'up' || event.name === 'k') {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return true;
      }
      if (event.name === 'down' || event.name === 'j') {
        setSelectedIndex((i) => Math.min(maxIndex, i + 1));
        return true;
      }
      if (event.name === 'return') {
        const file = files[selectedIndex];
        if (file) onSelect(file.path);
        return true;
      }
      return true;
    },
    onEscape: () => {
      onCancel();
      return true;
    },
  });

  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="single" borderColor={colors.border} padding={1} width={maxWidth !== undefined ? Math.min(50, maxWidth) : 50}>
      <Box marginBottom={1}>
        <Text bold>File Picker</Text>
        <Text dimColor> (Ctrl+F to close)</Text>
      </Box>
      {files.length === 0 ? (
        <Text dimColor>No files found</Text>
      ) : (
        <>
          {files.slice(0, maxItems).map((file, i) => (
            <Box key={file.path} flexDirection="row">
              <Text color={i === selectedIndex ? colors.primary : undefined}>
                {i === selectedIndex ? '▶ ' : '  '}
                {file.isDirectory ? '📁 ' : '📄 '}
                {file.name}
              </Text>
            </Box>
          ))}
          {files.length > maxItems && (
            <Text dimColor>… {files.length - maxItems} more</Text>
          )}
        </>
      )}
      <Box marginTop={1}>
        <Text dimColor>j/k: navigate · Enter: select · Esc: cancel</Text>
      </Box>
    </Box>
  );
}
