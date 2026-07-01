import React, { useState } from 'react';
import { Box, Text } from 'ink';

interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FilePickerProps {
  files: FileItem[];
  onSelect: (filePath: string) => void;
  onCancel: () => void;
}

export function FilePicker({ files, onSelect, onCancel }: FilePickerProps) {
  const [selectedIndex, setSelectedIndex] = useState(0);

  return (
    <Box flexDirection="column" borderStyle="single" padding={1} width={50}>
      <Box marginBottom={1}>
        <Text bold>File Picker</Text>
        <Text dimColor> (Ctrl+F to close)</Text>
      </Box>
      {files.length === 0 ? (
        <Text dimColor>No files found</Text>
      ) : (
        files.slice(0, 20).map((file, i) => (
          <Box key={file.path} flexDirection="row">
            <Text color={i === selectedIndex ? 'blue' : undefined}>
              {i === selectedIndex ? '▶ ' : '  '}
              {file.isDirectory ? '📁 ' : '📄 '}
              {file.name}
            </Text>
          </Box>
        ))
      )}
      <Box marginTop={1}>
        <Text dimColor>j/k: navigate · Enter: select · Esc: cancel</Text>
      </Box>
    </Box>
  );
}
