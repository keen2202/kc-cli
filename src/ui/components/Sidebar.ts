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

export interface SidebarSelection {
  section: SidebarSection;
  itemIndex: number;
}

export function createSidebarSelection(): SidebarSelection {
  return { section: 'tools', itemIndex: -1 };
}

export function sidebarMoveUp(data: SidebarData, sel: SidebarSelection): void {
  const items = getSectionItems(data, sel.section);
  if (sel.itemIndex > 0) sel.itemIndex--;
  else if (sel.itemIndex === -1 && items.length > 0) sel.itemIndex = items.length - 1;
}

export function sidebarMoveDown(data: SidebarData, sel: SidebarSelection): void {
  const items = getSectionItems(data, sel.section);
  if (sel.itemIndex < items.length - 1) sel.itemIndex++;
}

export function sidebarMoveLeft(data: SidebarData, sel: SidebarSelection): void {
  const sections: SidebarSection[] = ['tools', 'files', 'tasks', 'memory'];
  const idx = sections.indexOf(sel.section);
  if (idx > 0) {
    sel.section = sections[idx - 1];
    sel.itemIndex = -1;
  }
}

export function sidebarMoveRight(data: SidebarData, sel: SidebarSelection): void {
  const sections: SidebarSection[] = ['tools', 'files', 'tasks', 'memory'];
  const idx = sections.indexOf(sel.section);
  if (idx < sections.length - 1) {
    sel.section = sections[idx + 1];
    sel.itemIndex = -1;
  }
}

function getSectionItems(data: SidebarData, section: SidebarSection): any[] {
  switch (section) {
    case 'tools': return data.tools;
    case 'files': return data.files;
    case 'tasks': return data.tasks;
    case 'memory': return data.memories;
  }
}
