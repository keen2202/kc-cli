// Registry Coverage Tests for loadToolModule and TOOL_MANIFEST
// loadToolModule calls import(entry.modulePath) from src/tools/registry.ts.
// Paths relative to registry.ts: ./BashTool/index.js → src/tools/BashTool/index.ts

import { describe, it, expect } from 'vitest';
import { loadToolModule, ToolPriority, TOOL_MANIFEST, type ToolManifestEntry } from '../../src/tools/registry';

describe('TOOL_MANIFEST', () => {
  it('contains expected tool entries', () => {
    expect(TOOL_MANIFEST.length).toBeGreaterThan(0);
    const names = TOOL_MANIFEST.map(e => e.name);
    expect(names).toContain('Bash');
    expect(names).toContain('FileRead');
    expect(names).toContain('FileWrite');
    expect(names).toContain('Grep');
  });

  it('has no duplicate tool names', () => {
    const names = TOOL_MANIFEST.map(e => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all entries have module paths ending in .js', () => {
    for (const entry of TOOL_MANIFEST) {
      expect(entry.modulePath).toMatch(/\.js$/);
    }
  });

  it('entries are ordered by priority', () => {
    for (let i = 1; i < TOOL_MANIFEST.length; i++) {
      expect(TOOL_MANIFEST[i].priority).toBeGreaterThanOrEqual(TOOL_MANIFEST[i - 1].priority);
    }
  });
});

describe('ToolPriority', () => {
  it('has correct ordinal ordering', () => {
    expect(ToolPriority.CRITICAL).toBeLessThan(ToolPriority.HIGH);
    expect(ToolPriority.HIGH).toBeLessThan(ToolPriority.MEDIUM);
    expect(ToolPriority.MEDIUM).toBeLessThan(ToolPriority.LOW);
    expect(ToolPriority.LOW).toBeLessThan(ToolPriority.DEFERRED);
  });
});

describe('loadToolModule', () => {
  // Use paths relative to src/tools/registry.ts where loadToolModule is defined.
  // ./BashTool/index.js → src/tools/BashTool/index.ts

  it('loads a real tool from module using tool export', async () => {
    const entry: ToolManifestEntry = {
      name: 'Bash',
      modulePath: './BashTool/index.js',
      priority: ToolPriority.CRITICAL,
    };
    const result = await loadToolModule(entry);
    expect(result).toBeDefined();
    expect(result!.name).toBe('Bash');
    expect(result!.description).toBeDefined();
    expect(result!.inputSchema).toBeDefined();
  });

  it('loads FileRead tool', async () => {
    const entry: ToolManifestEntry = {
      name: 'FileRead',
      modulePath: './FileReadTool/index.js',
      priority: ToolPriority.CRITICAL,
    };
    const result = await loadToolModule(entry);
    expect(result).toBeDefined();
    expect(result!.name).toBe('FileRead');
  });

  it('loads Grep tool', async () => {
    const entry: ToolManifestEntry = {
      name: 'Grep',
      modulePath: './GrepTool/index.js',
      priority: ToolPriority.HIGH,
    };
    const result = await loadToolModule(entry);
    expect(result).toBeDefined();
    expect(result!.name).toBe('Grep');
  });

  it('returns undefined for non-existent module path', async () => {
    const entry: ToolManifestEntry = {
      name: 'NonExistent',
      modulePath: './NonExistentTool/index.js',
      priority: ToolPriority.LOW,
    };
    const result = await loadToolModule(entry);
    expect(result).toBeUndefined();
  });

  it('loads multiple tools independently', async () => {
    const bashEntry: ToolManifestEntry = {
      name: 'Bash', modulePath: './BashTool/index.js', priority: 0,
    };
    const grepEntry: ToolManifestEntry = {
      name: 'Grep', modulePath: './GrepTool/index.js', priority: 10,
    };

    const [bashTool, grepTool] = await Promise.all([
      loadToolModule(bashEntry),
      loadToolModule(grepEntry),
    ]);

    expect(bashTool).toBeDefined();
    expect(bashTool!.name).toBe('Bash');
    expect(grepTool).toBeDefined();
    expect(grepTool!.name).toBe('Grep');
  });
});
