// Real ink sidebar panel — consumes live SidebarData collected by
// useStreamingEvents. Replaces the static SidebarPlaceholder in AppRoot.

import React from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../hooks/useTheme';
import type { ThemeColors } from '../theme';
import type {
  SidebarData,
  SidebarTool,
  SidebarTask,
  SidebarFile,
} from './Sidebar';

interface SidebarPanelProps {
  data: SidebarData;
  /** Total row height allotted to the right column (used to budget items). */
  height?: number;
  width?: number;
}

function toolStatusColor(status: SidebarTool['status'], colors: ThemeColors): string {
  switch (status) {
    case 'running': return colors.primary;
    case 'completed': return colors.success;
    case 'failed': return colors.error;
    default: return colors.muted;
  }
}

function toolStatusIcon(status: SidebarTool['status']): string {
  switch (status) {
    case 'running': return '⟳';
    case 'completed': return '✓';
    case 'failed': return '✗';
    default: return '·';
  }
}

function taskStatusIcon(status: SidebarTask['status']): string {
  switch (status) {
    case 'in_progress': return '⟳';
    case 'completed': return '✓';
    case 'blocked': return '⏸';
    default: return '·';
  }
}

function taskStatusColor(status: SidebarTask['status'], colors: ThemeColors): string {
  switch (status) {
    case 'in_progress': return colors.primary;
    case 'completed': return colors.success;
    case 'blocked': return colors.warning;
    default: return colors.muted;
  }
}

function fileIcon(file: SidebarFile, colors: ThemeColors): { icon: string; color: string } {
  if (file.hasError) return { icon: '✗', color: colors.error };
  if (file.hasWarning) return { icon: '⚠', color: colors.warning };
  return { icon: '·', color: colors.muted };
}

interface SectionProps {
  title: string;
  count: number;
  emptyLabel: string;
  children?: React.ReactNode;
}

function Section({ title, count, emptyLabel, children }: SectionProps) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>
        {title}
        {count > 0 ? <Text dimColor> ({count})</Text> : null}
      </Text>
      {count === 0 ? <Text dimColor>  {emptyLabel}</Text> : children}
    </Box>
  );
}

export function SidebarPanel({ data, height, width }: SidebarPanelProps) {
  const { colors } = useTheme();
  // Budget how many items each section may show so the panel never overflows
  // the right column. Four section headers + borders consume ~9 rows; the
  // remainder is split only across the populated sections (empty sections
  // consume no item budget), so active sections each get more rows.
  const budget = Math.max(2, (height ?? 20) - 9);
  const activeSections =
    (data.tools.length > 0 ? 1 : 0) +
    (data.files.length > 0 ? 1 : 0) +
    (data.tasks.length > 0 ? 1 : 0) +
    (data.memories.length > 0 ? 1 : 0);
  const perSection = Math.max(1, Math.floor(budget / Math.max(1, activeSections)));

  const tools = data.tools.slice(-perSection);
  const files = data.files.slice(-perSection);
  const tasks = data.tasks.slice(-perSection);
  const memories = data.memories.slice(-perSection);

  const maxName = Math.max(6, (width ?? 30) - 8);
  const clip = (s: string) => (s.length > maxName ? s.slice(0, maxName - 1) + '…' : s);

  return (
    <Box flexDirection="column" borderStyle="single" paddingLeft={1} paddingRight={1}>
      <Section title="Tools" count={data.tools.length} emptyLabel="No tool calls yet">
        {tools.map((tool, i) => (
          <Text key={`tool-${i}`}>
            <Text color={toolStatusColor(tool.status, colors)}>{toolStatusIcon(tool.status)} </Text>
            <Text>{clip(tool.name)}</Text>
            {tool.duration ? <Text dimColor> {tool.duration}</Text> : null}
          </Text>
        ))}
      </Section>

      <Section title="Files" count={data.files.length} emptyLabel="No files tracked">
        {files.map((file, i) => {
          const { icon, color } = fileIcon(file, colors);
          return (
            <Text key={`file-${i}`}>
              <Text color={color}>{icon} </Text>
              <Text dimColor>{clip(file.path)}</Text>
            </Text>
          );
        })}
      </Section>

      <Section title="Tasks" count={data.tasks.length} emptyLabel="No tasks yet">
        {tasks.map((task, i) => (
          <Text key={`task-${i}`}>
            <Text color={taskStatusColor(task.status, colors)}>{taskStatusIcon(task.status)} </Text>
            <Text dimColor>{clip(task.title)}</Text>
          </Text>
        ))}
      </Section>

      <Section title="Memory" count={data.memories.length} emptyLabel="No memories yet">
        {memories.map((mem, i) => (
          <Text key={`mem-${i}`}>
            <Text color={colors.primary}>· </Text>
            <Text dimColor>{clip(mem.name)}</Text>
          </Text>
        ))}
      </Section>
    </Box>
  );
}
