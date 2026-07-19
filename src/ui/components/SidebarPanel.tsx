// Real ink sidebar panel — consumes live SidebarData collected by
// useStreamingEvents. Replaces the static SidebarPlaceholder in AppRoot.
// The string-rendering counterpart (renderSidebar in Sidebar.ts) belongs to
// the legacy dead path and is intentionally left untouched.

import React from 'react';
import { Box, Text } from 'ink';
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

type InkColor = 'blue' | 'green' | 'red' | 'yellow' | 'cyan' | 'gray';

function toolStatusColor(status: SidebarTool['status']): InkColor {
  switch (status) {
    case 'running': return 'blue';
    case 'completed': return 'green';
    case 'failed': return 'red';
    default: return 'gray';
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

function taskStatusColor(status: SidebarTask['status']): InkColor {
  switch (status) {
    case 'in_progress': return 'blue';
    case 'completed': return 'green';
    case 'blocked': return 'yellow';
    default: return 'gray';
  }
}

function fileIcon(file: SidebarFile): { icon: string; color: InkColor } {
  if (file.hasError) return { icon: '✗', color: 'red' };
  if (file.hasWarning) return { icon: '⚠', color: 'yellow' };
  return { icon: '·', color: 'gray' };
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
  // Budget how many items each section may show so the panel never overflows
  // the right column. Four section headers + borders consume ~9 rows; the rest
  // is split across the populated sections.
  const budget = Math.max(2, (height ?? 20) - 9);
  const perSection = Math.max(1, Math.floor(budget / 4));

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
            <Text color={toolStatusColor(tool.status)}>{toolStatusIcon(tool.status)} </Text>
            <Text>{clip(tool.name)}</Text>
            {tool.duration ? <Text dimColor> {tool.duration}</Text> : null}
          </Text>
        ))}
      </Section>

      <Section title="Files" count={data.files.length} emptyLabel="No files tracked">
        {files.map((file, i) => {
          const { icon, color } = fileIcon(file);
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
            <Text color={taskStatusColor(task.status)}>{taskStatusIcon(task.status)} </Text>
            <Text dimColor>{clip(task.title)}</Text>
          </Text>
        ))}
      </Section>

      <Section title="Memory" count={data.memories.length} emptyLabel="No memories yet">
        {memories.map((mem, i) => (
          <Text key={`mem-${i}`}>
            <Text color="cyan">· </Text>
            <Text dimColor>{clip(mem.name)}</Text>
          </Text>
        ))}
      </Section>
    </Box>
  );
}
