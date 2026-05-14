import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import chalk from 'chalk';
import { computeDiff, type DiffLine } from '../diff-viewer';

export interface FileDiff {
  filePath: string;
  oldContent: string | null; // null for new files
  newContent: string;
  accepted: boolean;
  rejected: boolean;
}

interface DiffPreviewProps {
  diffs: FileDiff[];
  activeFileIndex?: number;
  onAccept?: (filePath: string) => void;
  onReject?: (filePath: string) => void;
  onFileChange?: (index: number) => void;
  maxWidth?: number;
  maxLines?: number;
}

interface DiffLineRowProps {
  line: DiffLine;
  maxWidth: number;
}

const DiffLineRow: React.FC<DiffLineRowProps> = ({ line, maxWidth }) => {
  const lineNumWidth = 4;
  const gutterWidth = 10; // "  123 │ " or "+ 123 │ "

  const formatLine = (): string => {
    const lineNum = line.type === 'remove'
      ? String(line.oldLineNum || '').padStart(lineNumWidth)
      : String(line.newLineNum || '').padStart(lineNumWidth);

    const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';

    const content = line.content.length > maxWidth - gutterWidth - lineNumWidth - 1
      ? line.content.slice(0, maxWidth - gutterWidth - lineNumWidth - 1) + '…'
      : line.content;

    return `${prefix} ${lineNum} │ ${content}`;
  };

  const renderStyled = () => {
    const formatted = formatLine();
    switch (line.type) {
      case 'add':
        return <Text color="green">{formatted}</Text>;
      case 'remove':
        return <Text color="red">{formatted}</Text>;
      default:
        return <Text dimColor>{formatted}</Text>;
    }
  };

  return <Box>{renderStyled()}</Box>;
};

interface FileTabProps {
  diff: FileDiff;
  isActive: boolean;
  index: number;
  onClick: () => void;
}

const FileTab: React.FC<FileTabProps> = ({ diff, isActive, index, onClick }) => {
  const fileName = diff.filePath.split('/').pop() || diff.filePath;
  const changeCount = countChanges(diff);

  const label = isActive
    ? `[${index + 1}] ${fileName} (${changeCount})`
    : ` ${index + 1}. ${fileName} (${changeCount})`;

  return (
    <Box>
      <Text bold={isActive} color={isActive ? 'cyan' : 'gray'}>
        {label}
      </Text>
    </Box>
  );
};

function countChanges(diff: FileDiff): string {
  if (diff.accepted) return '✓';
  if (diff.rejected) return '✗';
  const diffLines = computeDiff(diff.oldContent || '', diff.newContent);
  const adds = diffLines.filter(l => l.type === 'add').length;
  const removes = diffLines.filter(l => l.type === 'remove').length;
  return `+${adds} -${removes}`;
}

const DiffPreview: React.FC<DiffPreviewProps> = ({
  diffs,
  activeFileIndex = 0,
  onAccept,
  onReject,
  onFileChange,
  maxWidth = 80,
  maxLines = 30,
}) => {
  const [activeIndex, setActiveIndex] = useState(activeFileIndex);
  const activeDiff = diffs[activeIndex];

  const diffLines = useMemo(() => {
    if (!activeDiff) return [];
    return computeDiff(activeDiff.oldContent || '', activeDiff.newContent);
  }, [activeDiff]);

  const visibleLines = useMemo(() => {
    return diffLines.slice(0, maxLines);
  }, [diffLines, maxLines]);

  const handleFileSelect = useCallback((index: number) => {
    setActiveIndex(index);
    onFileChange?.(index);
  }, [onFileChange]);

  if (diffs.length === 0) {
    return (
      <Box flexDirection="column">
        <Text dimColor>  No pending changes.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* File tabs */}
      <Box>
        <Text color="gray" bold>┌─ </Text>
        <Text color="cyan" bold>Diff Preview</Text>
        <Text color="gray"> ─</Text>
        <Text dimColor>{` (${activeIndex + 1}/${diffs.length})`}</Text>
        <Text color="gray" bold> ─┐</Text>
      </Box>

      {/* Tab bar for multi-file */}
      {diffs.length > 1 && (
        <Box flexDirection="column" paddingLeft={2}>
          {diffs.map((diff, index) => (
            <FileTab
              key={diff.filePath}
              diff={diff}
              isActive={index === activeIndex}
              index={index}
              onClick={() => handleFileSelect(index)}
            />
          ))}
        </Box>
      )}

      {/* Diff content */}
      <Box flexDirection="column" paddingLeft={2}>
        {activeDiff && (
          <Box>
            <Text dimColor>  File: </Text>
            <Text bold>{activeDiff.filePath}</Text>
            {activeDiff.oldContent === null && (
              <Text color="green"> (new file)</Text>
            )}
          </Box>
        )}

        <Box>
          <Text color="gray">  {'─'.repeat(Math.min(maxWidth - 4, 60))}</Text>
        </Box>

        {visibleLines.map((line, i) => (
          <DiffLineRow key={i} line={line} maxWidth={maxWidth} />
        ))}

        {diffLines.length > maxLines && (
          <Text dimColor>{`  ... (${diffLines.length - maxLines} more lines)`}</Text>
        )}
      </Box>

      {/* Action bar */}
      <Box paddingLeft={2}>
        <Text color="gray">  {'─'.repeat(Math.min(maxWidth - 4, 60))}</Text>
      </Box>

      <Box paddingLeft={2}>
        <Text dimColor>  [A]ccept  [R]eject  [←/→] Switch file  [Q]uit</Text>
      </Box>

      <Box>
        <Text color="gray" bold>└{'─'.repeat(Math.min(maxWidth - 2, 62))}┘</Text>
      </Box>
    </Box>
  );
};

export { DiffPreview as default, DiffLineRow, FileTab };
export type { FileDiff };
