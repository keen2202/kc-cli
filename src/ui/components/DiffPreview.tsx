import React, { useState, useCallback, useMemo } from 'react';
import { Box, Text } from 'ink';
import { computeDiff, type DiffLine } from '../diff-viewer';
import { useTerminalSize } from '../hooks/useTerminalSize';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../theme';

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
  /** Show the built-in [A]ccept/[R]eject action bar. Suppressed when the
   *  parent (e.g. the permission dialog) owns the accept/reject keys. */
  showActions?: boolean;
}

interface DiffLineRowProps {
  line: DiffLine;
  maxWidth: number;
  colors: ThemeColors;
}

const DiffLineRow: React.FC<DiffLineRowProps> = ({ line, maxWidth, colors }) => {
  const lineNumWidth = 4;
  const gutterWidth = 10;

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

  const formatted = formatLine();
  switch (line.type) {
    case 'add':
      return <Box><Text color={colors.success}>{formatted}</Text></Box>;
    case 'remove':
      return <Box><Text color={colors.error}>{formatted}</Text></Box>;
    default:
      return <Box><Text color={colors.muted}>{formatted}</Text></Box>;
  }
};

interface FileTabProps {
  diff: FileDiff;
  isActive: boolean;
  index: number;
  onClick: () => void;
  colors: ThemeColors;
}

const FileTab: React.FC<FileTabProps> = ({ diff, isActive, index, colors }) => {
  const fileName = diff.filePath.split('/').pop() || diff.filePath;
  const changeCount = countChanges(diff);

  const label = isActive
    ? `[${index + 1}] ${fileName} (${changeCount})`
    : ` ${index + 1}. ${fileName} (${changeCount})`;

  return (
    <Box>
      <Text bold={isActive} color={isActive ? colors.primary : colors.muted}>
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
  onFileChange,
  maxWidth: propMaxWidth,
  maxLines = 30,
  showActions = true,
}) => {
  const { colors } = useTheme();
  const termMaxWidth = useTerminalSize().width;
  const maxWidth = propMaxWidth ?? termMaxWidth;
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
        <Text color={colors.muted}>  No pending changes.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="single" borderColor={colors.border} paddingLeft={1} paddingRight={1}>
      {/* Title */}
      <Box>
        <Text color={colors.primary} bold>Diff Preview</Text>
        <Text color={colors.muted}>{` (${activeIndex + 1}/${diffs.length})`}</Text>
      </Box>

      {/* Tab bar for multi-file */}
      {diffs.length > 1 && (
        <Box flexDirection="column">
          {diffs.map((diff, index) => (
            <FileTab
              key={diff.filePath}
              diff={diff}
              isActive={index === activeIndex}
              index={index}
              onClick={() => handleFileSelect(index)}
              colors={colors}
            />
          ))}
        </Box>
      )}

      {/* Diff content */}
      <Box flexDirection="column">
        {activeDiff && (
          <Box>
            <Text color={colors.muted}>File: </Text>
            <Text bold>{activeDiff.filePath}</Text>
            {activeDiff.oldContent === null && (
              <Text color={colors.success}> (new file)</Text>
            )}
          </Box>
        )}

        {visibleLines.map((line, i) => (
          <DiffLineRow key={i} line={line} maxWidth={maxWidth} colors={colors} />
        ))}

        {diffLines.length > maxLines && (
          <Text color={colors.muted}>{`  ... (${diffLines.length - maxLines} more lines)`}</Text>
        )}
      </Box>

      {/* Action bar */}
      {showActions && (
        <Box>
          <Text color={colors.muted}>[A]ccept  [R]eject  [←/→] Switch file  [Q]uit</Text>
        </Box>
      )}
    </Box>
  );
};

export { DiffPreview as default, DiffLineRow, FileTab };
