// test/tools/lazy-split.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { toolRegistry, registerBuiltInTools } from '../../src/tools.js';
import { TOOL_MANIFEST } from '../../src/tools/registry';
import { initializeState } from '../../src/bootstrap/state';

beforeEach(() => {
  initializeState();
});

describe('eager registration after lazy split', () => {
  it('registers every manifest tool without any preload step', async () => {
    await registerBuiltInTools();
    const names = toolRegistry.getAllTools().map(t => t.name);
    for (const entry of TOOL_MANIFEST) {
      expect(names, `missing tool ${entry.name} without preload`).toContain(entry.name);
    }
  });

  it('split tool entries expose metadata without loading impl', async () => {
    await registerBuiltInTools();
    for (const name of ['Sql', 'Agent', 'LSP', 'TeamCreate'] as const) {
      const tool = toolRegistry.getTool(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool!.description.length).toBeGreaterThan(0);
      expect(tool!.inputSchema).toBeDefined();
    }
  });
});
