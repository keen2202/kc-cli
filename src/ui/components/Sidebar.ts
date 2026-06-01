import chalk from 'chalk';
import type { Theme } from '../theme';

/**
 * Sidebar section types.
 */
export type SidebarSection = 'files' | 'tools' | 'tasks' | 'memory';

export interface SidebarFile {
  path: string;
  hasError?: boolean;
  hasWarning?: boolean;
}

export interface SidebarTool {
  name: string;
  status: 'running' | 'completed' | 'failed' | 'pending';
  duration?: string;
}

export interface SidebarTask {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
}

export interface SidebarData {
  /** Currently active section */
  activeSection: SidebarSection;
  /** File tree items */
  files: SidebarFile[];
  /** Recent tool calls */
  tools: SidebarTool[];
  /** Task list items */
  tasks: SidebarTask[];
  /** Memory items */
  memories: Array<{ name: string; type: string }>;
  /** Whether sidebar is visible */
  visible: boolean;
}

/**
 * Default sidebar data.
 */
export function createSidebarData(): SidebarData {
  return {
    activeSection: 'tools',
    files: [],
    tools: [],
    tasks: [],
    memories: [],
    visible: true,
  };
}

/**
 * Render the sidebar panel.
 */
export function renderSidebar(data: SidebarData, width: number = 30, theme?: Theme): string {
  if (!data.visible) {
    return '';
  }

  const tokens = theme?.resolve();
  const lines: string[] = [];
  const divider = chalk.gray.dim('│');

  // Section tabs
  const sections: Array<{ key: SidebarSection; label: string; icon: string }> = [
    { key: 'tools', label: 'Tools', icon: '🔧' },
    { key: 'files', label: 'Files', icon: '📁' },
    { key: 'tasks', label: 'Tasks', icon: '📋' },
    { key: 'memory', label: 'Memory', icon: '🧠' },
  ];

  // Render tab bar
  const tabBar = sections.map(s => {
    const isActive = s.key === data.activeSection;
    if (isActive) {
      return tokens ? tokens['sidebar.tab.active'](`${s.icon} ${s.label}`) : chalk.bold.cyan(`${s.icon} ${s.label}`);
    }
    return tokens ? tokens['sidebar.tab.inactive'](`${s.icon} ${s.label}`) : chalk.gray.dim(`${s.icon} ${s.label}`);
  }).join(chalk.gray.dim(' | '));

  lines.push(chalk.gray.dim('┌' + '─'.repeat(width - 2) + '┐'));
  lines.push(`${divider} ${tabBar.padEnd(width - 4)} ${divider}`);
  lines.push(chalk.gray.dim('├' + '─'.repeat(width - 2) + '┤'));

  // Render active section content
  switch (data.activeSection) {
    case 'tools':
      lines.push(...renderToolsSection(data.tools, width, theme));
      break;
    case 'files':
      lines.push(...renderFilesSection(data.files, width, theme));
      break;
    case 'tasks':
      lines.push(...renderTasksSection(data.tasks, width, theme));
      break;
    case 'memory':
      lines.push(...renderMemorySection(data.memories, width, theme));
      break;
  }

  // Fill remaining space to maintain consistent height
  const minHeight = 12;
  while (lines.length < minHeight + 3) {
    lines.push(`${divider}${' '.repeat(width - 2)}${divider}`);
  }

  lines.push(chalk.gray.dim('└' + '─'.repeat(width - 2) + '┘'));

  return lines.join('\n');
}

function renderToolsSection(tools: SidebarTool[], width: number, theme?: Theme): string[] {
  const tokens = theme?.resolve();
  const lines: string[] = [];
  const divider = chalk.gray.dim('│');

  if (tools.length === 0) {
    lines.push(`${divider}${' '.repeat(width - 2)}${divider}`);
    lines.push(`${divider} ${chalk.gray.dim('No tool calls yet')}${' '.repeat(Math.max(0, width - 24))}${divider}`);
    return lines;
  }

  for (const tool of tools.slice(-8)) {
    const statusIcon = getStatusIcon(tool.status, tokens);
    const statusColor = getStatusColor(tool.status, tokens);
    const name = tool.name.padEnd(Math.min(18, width - 12));
    const duration = tool.duration ? ` ${chalk.gray.dim(tool.duration)}` : '';

    lines.push(`${divider} ${statusIcon} ${statusColor(name)}${duration}${' '.repeat(Math.max(0, width - name.length - duration.length - 6))}${divider}`);
  }

  return lines;
}

function renderFilesSection(files: SidebarFile[], width: number, theme?: Theme): string[] {
  const tokens = theme?.resolve();
  const lines: string[] = [];
  const divider = chalk.gray.dim('│');

  if (files.length === 0) {
    lines.push(`${divider}${' '.repeat(width - 2)}${divider}`);
    lines.push(`${divider} ${chalk.gray.dim('No files tracked')}${' '.repeat(Math.max(0, width - 20))}${divider}`);
    return lines;
  }

  for (const file of files.slice(-10)) {
    const icon = file.hasError
      ? (tokens ? tokens['error.text']('✗') : chalk.red('✗'))
      : file.hasWarning
        ? (tokens ? tokens['warning.text']('⚠') : chalk.yellow('⚠'))
        : chalk.gray('·');
    const pathStr = chalk.dim(file.path.length > width - 8 ? '…' + file.path.slice(-(width - 9)) : file.path);

    lines.push(`${divider} ${icon} ${pathStr}${' '.repeat(Math.max(0, width - file.path.length - 6))}${divider}`);
  }

  return lines;
}

function renderTasksSection(tasks: SidebarTask[], width: number, theme?: Theme): string[] {
  const tokens = theme?.resolve();
  const lines: string[] = [];
  const divider = chalk.gray.dim('│');

  if (tasks.length === 0) {
    lines.push(`${divider}${' '.repeat(width - 2)}${divider}`);
    lines.push(`${divider} ${chalk.gray.dim('No tasks yet')}${' '.repeat(Math.max(0, width - 15))}${divider}`);
    return lines;
  }

  for (const task of tasks.slice(-8)) {
    const icon = getTaskIcon(task.status, tokens);
    const title = task.title.length > width - 8
      ? task.title.slice(0, width - 9) + '…'
      : task.title;

    lines.push(`${divider} ${icon} ${chalk.dim(title)}${' '.repeat(Math.max(0, width - title.length - 6))}${divider}`);
  }

  return lines;
}

function renderMemorySection(memories: Array<{ name: string; type: string }>, width: number, theme?: Theme): string[] {
  const tokens = theme?.resolve();
  const lines: string[] = [];
  const divider = chalk.gray.dim('│');

  if (memories.length === 0) {
    lines.push(`${divider}${' '.repeat(width - 2)}${divider}`);
    lines.push(`${divider} ${chalk.gray.dim('No memories yet')}${' '.repeat(Math.max(0, width - 19))}${divider}`);
    return lines;
  }

  for (const mem of memories.slice(-8)) {
    const typeIcon = getMemoryTypeIcon(mem.type, tokens);
    const name = mem.name.length > width - 8
      ? mem.name.slice(0, width - 9) + '…'
      : mem.name;

    lines.push(`${divider} ${typeIcon} ${chalk.dim(name)}${' '.repeat(Math.max(0, width - name.length - 6))}${divider}`);
  }

  return lines;
}

function getStatusIcon(status: string, tokens?: ReturnType<Theme['resolve']>): string {
  switch (status) {
    case 'running': return tokens ? tokens['tool.running']('⟳') : chalk.blue('⟳');
    case 'completed': return tokens ? tokens['tool.success']('✓') : chalk.green('✓');
    case 'failed': return tokens ? tokens['tool.failed']('✗') : chalk.red('✗');
    default: return chalk.gray('·');
  }
}

function getStatusColor(status: string, tokens?: ReturnType<Theme['resolve']>): (s: string) => string {
  switch (status) {
    case 'running': return tokens ? tokens['tool.running'] : chalk.blue;
    case 'completed': return tokens ? tokens['tool.success'] : chalk.green;
    case 'failed': return tokens ? tokens['tool.failed'] : chalk.red;
    default: return chalk.gray;
  }
}

function getTaskIcon(status: string, tokens?: ReturnType<Theme['resolve']>): string {
  switch (status) {
    case 'in_progress': return tokens ? tokens['tool.running']('⟳') : chalk.blue('⟳');
    case 'completed': return tokens ? tokens['tool.success']('✓') : chalk.green('✓');
    case 'blocked': return tokens ? tokens['warning.text']('⏸') : chalk.yellow('⏸');
    default: return chalk.gray('·');
  }
}

function getMemoryTypeIcon(type: string, tokens?: ReturnType<Theme['resolve']>): string {
  switch (type) {
    case 'user': return chalk.cyan('👤');
    case 'feedback': return chalk.yellow('💬');
    case 'project': return chalk.green('📦');
    case 'reference': return chalk.gray('📎');
    default: return chalk.gray('·');
  }
}
