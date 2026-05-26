import { describe, it, expect } from 'vitest';
import {
  ToolPriority,
  TOOL_MANIFEST,
  type ToolManifestEntry,
} from './registry';

describe('ToolPriority', () => {
  it('orders priorities correctly', () => {
    expect(ToolPriority.CRITICAL).toBeLessThan(ToolPriority.HIGH);
    expect(ToolPriority.HIGH).toBeLessThan(ToolPriority.MEDIUM);
    expect(ToolPriority.MEDIUM).toBeLessThan(ToolPriority.LOW);
    expect(ToolPriority.LOW).toBeLessThan(ToolPriority.DEFERRED);
  });
});

describe('TOOL_MANIFEST', () => {
  it('contains all expected tools', () => {
    const names = TOOL_MANIFEST.map(e => e.name);
    expect(names).toContain('Bash');
    expect(names).toContain('FileRead');
    expect(names).toContain('FileWrite');
    expect(names).toContain('Grep');
    expect(names).toContain('Git');
    expect(names).toContain('Sql');
    expect(names).toContain('Agent');
  });

  it('has no duplicate tool names', () => {
    const names = TOOL_MANIFEST.map(e => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has eager tools for CRITICAL and HIGH priority', () => {
    for (const entry of TOOL_MANIFEST) {
      if (entry.priority <= ToolPriority.HIGH) {
        expect(entry.eager).toBe(true);
      }
    }
  });

  it('has module paths for all entries', () => {
    for (const entry of TOOL_MANIFEST) {
      expect(entry.modulePath).toBeTruthy();
      expect(entry.modulePath).toContain('.js');
    }
  });

  it('orders entries by priority', () => {
    // Entries should be in priority order
    let lastPriority = -1;
    for (const entry of TOOL_MANIFEST) {
      expect(entry.priority).toBeGreaterThanOrEqual(lastPriority);
      lastPriority = entry.priority;
    }
  });

  it('includes LSP and TeamCreate as deferred tools', () => {
    const deferred = TOOL_MANIFEST.filter(e => e.priority === ToolPriority.DEFERRED);
    const names = deferred.map(e => e.name);
    expect(names).toContain('TeamCreate');
    expect(names).toContain('LSP');
  });
});
