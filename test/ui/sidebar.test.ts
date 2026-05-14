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
});
