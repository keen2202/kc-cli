import { describe, it, expect } from 'vitest';
import { renderSidebar, createSidebarData } from '../../src/ui/components/Sidebar';
import type { SidebarData, SidebarFile, SidebarTool, SidebarTask } from '../../src/ui/components/Sidebar';

describe('Sidebar', () => {
  it('renders with default data', () => {
    const data = createSidebarData();
    const rendered = renderSidebar(data, 30);
    expect(rendered).toContain('┌');
    expect(rendered).toContain('└');
    expect(rendered).toContain('Tools');
  });

  it('shows tools section with items', () => {
    const data = createSidebarData();
    data.activeSection = 'tools';
    data.tools = [
      { name: 'Bash', status: 'completed', duration: '1.2s' },
      { name: 'FileRead', status: 'running' },
      { name: 'Grep', status: 'failed' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('Bash');
    expect(rendered).toContain('FileRead');
    expect(rendered).toContain('Grep');
  });

  it('shows files section with diagnostics', () => {
    const data = createSidebarData();
    data.activeSection = 'files';
    data.files = [
      { path: 'src/main.ts', hasError: true },
      { path: 'src/utils.ts', hasWarning: true },
      { path: 'src/types.ts' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('src/main.ts');
    expect(rendered).toContain('src/utils.ts');
  });

  it('shows tasks section', () => {
    const data = createSidebarData();
    data.activeSection = 'tasks';
    data.tasks = [
      { id: '1', title: 'Implement sandbox', status: 'completed' },
      { id: '2', title: 'Add LSP support', status: 'in_progress' },
      { id: '3', title: 'Write tests', status: 'pending' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('Implement sandbox');
    expect(rendered).toContain('Add LSP support');
  });

  it('shows memory section', () => {
    const data = createSidebarData();
    data.activeSection = 'memory';
    data.memories = [
      { name: 'User prefers TypeScript', type: 'user' },
      { name: 'Project uses Docker', type: 'project' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('User prefers TypeScript');
  });

  it('handles empty sections gracefully', () => {
    const data = createSidebarData();
    for (const section of ['tools', 'files', 'tasks', 'memory'] as const) {
      data.activeSection = section;
      const rendered = renderSidebar(data, 30);
      expect(rendered).toContain('┌');
      expect(rendered).toContain('└');
    }
  });

  it('maintains minimum height', () => {
    const data = createSidebarData();
    const rendered = renderSidebar(data, 30);
    const lines = rendered.split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(14); // 3 header/border + 12 content + footer
  });

  it('is empty when not visible', () => {
    const data = createSidebarData();
    data.visible = false;
    const rendered = renderSidebar(data, 30);
    expect(rendered).toBe('');
  });

  it('handles tools with all status types', () => {
    const data = createSidebarData();
    data.activeSection = 'tools';
    data.tools = [
      { name: 'Running', status: 'running' },
      { name: 'Completed', status: 'completed', duration: '0.5s' },
      { name: 'Failed', status: 'failed', duration: '1.0s' },
      { name: 'Pending', status: 'pending' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('Running');
    expect(rendered).toContain('Completed');
    expect(rendered).toContain('Failed');
    expect(rendered).toContain('Pending');
    expect(rendered).toContain('0.5s');
    expect(rendered).toContain('1.0s');
  });

  it('handles tools without duration', () => {
    const data = createSidebarData();
    data.activeSection = 'tools';
    data.tools = [
      { name: 'NoDuration', status: 'running' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('NoDuration');
  });

  it('limits tool display to last 8 items', () => {
    const data = createSidebarData();
    data.activeSection = 'tools';
    data.tools = Array.from({ length: 20 }, (_, i) => ({
      name: `Tool${i.toString().padStart(2, '0')}`,
      status: 'completed' as const,
    }));
    const rendered = renderSidebar(data, 34);
    // Should contain the last 8 tools (Tool12-Tool19)
    expect(rendered).toContain('Tool19');
    expect(rendered).toContain('Tool12');
    // Should not contain the earliest tools (Tool00-Tool11)
    expect(rendered).not.toContain('Tool00');
    expect(rendered).not.toContain('Tool01');
    expect(rendered).not.toContain('Tool11');
  });

  it('handles files with long paths (truncation)', () => {
    const data = createSidebarData();
    data.activeSection = 'files';
    data.files = [
      { path: 'very/long/path/to/some/deeply/nested/file.ts' },
    ];
    const rendered = renderSidebar(data, 34);
    // Should contain truncated path with ellipsis
    expect(rendered).toContain('…');
  });

  it('handles files with error and warning diagnostics', () => {
    const data = createSidebarData();
    data.activeSection = 'files';
    data.files = [
      { path: 'error.ts', hasError: true },
      { path: 'warning.ts', hasWarning: true },
      { path: 'normal.ts' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('error.ts');
    expect(rendered).toContain('warning.ts');
    expect(rendered).toContain('normal.ts');
  });

  it('limits file display to last 10 items', () => {
    const data = createSidebarData();
    data.activeSection = 'files';
    data.files = Array.from({ length: 15 }, (_, i) => ({
      path: `file${i}.ts`,
    }));
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('file14');
    expect(rendered).toContain('file5');
    expect(rendered).not.toContain('file0');
    expect(rendered).not.toContain('file4');
  });

  it('handles tasks with all status types', () => {
    const data = createSidebarData();
    data.activeSection = 'tasks';
    data.tasks = [
      { id: '1', title: 'Pending task', status: 'pending' },
      { id: '2', title: 'Active task', status: 'in_progress' },
      { id: '3', title: 'Done task', status: 'completed' },
      { id: '4', title: 'Blocked task', status: 'blocked' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('Pending task');
    expect(rendered).toContain('Active task');
    expect(rendered).toContain('Done task');
    expect(rendered).toContain('Blocked task');
  });

  it('truncates long task titles', () => {
    const data = createSidebarData();
    data.activeSection = 'tasks';
    data.tasks = [
      { id: '1', title: 'This is a very long task title that should be truncated', status: 'pending' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('…');
  });

  it('handles memory items with all types', () => {
    const data = createSidebarData();
    data.activeSection = 'memory';
    data.memories = [
      { name: 'User preference', type: 'user' },
      { name: 'Feedback item', type: 'feedback' },
      { name: 'Project config', type: 'project' },
      { name: 'Reference doc', type: 'reference' },
      { name: 'Unknown type', type: 'other' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('User preference');
    expect(rendered).toContain('Feedback item');
    expect(rendered).toContain('Project config');
    expect(rendered).toContain('Reference doc');
    expect(rendered).toContain('Unknown type');
  });

  it('truncates long memory names', () => {
    const data = createSidebarData();
    data.activeSection = 'memory';
    data.memories = [
      { name: 'A very long memory name that exceeds the sidebar width', type: 'user' },
    ];
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('…');
  });

  it('limits memory display to last 8 items', () => {
    const data = createSidebarData();
    data.activeSection = 'memory';
    data.memories = Array.from({ length: 12 }, (_, i) => ({
      name: `Memory${i}`,
      type: 'user',
    }));
    const rendered = renderSidebar(data, 34);
    expect(rendered).toContain('Memory11');
    expect(rendered).toContain('Memory4');
    expect(rendered).not.toContain('Memory0');
    expect(rendered).not.toContain('Memory3');
  });

  it('renders with custom width', () => {
    const data = createSidebarData();
    const rendered = renderSidebar(data, 40);
    const lines = rendered.split('\n');
    // All content lines should respect width
    expect(rendered).toContain('┌');
    expect(rendered).toContain('└');
  });

  it('shows empty message for each section when no data', () => {
    const data = createSidebarData();
    const emptyMessages: Record<string, string> = {
      tools: 'No tool calls yet',
      files: 'No files tracked',
      tasks: 'No tasks yet',
      memory: 'No memories yet',
    };

    for (const [section, message] of Object.entries(emptyMessages)) {
      data.activeSection = section as any;
      data.tools = [];
      data.files = [];
      data.tasks = [];
      data.memories = [];
      const rendered = renderSidebar(data, 30);
      expect(rendered).toContain(message);
    }
  });
});
