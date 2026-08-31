// T22 (P1): heavy tool modules must not sit on the serial startup path — round4 §5-P1
//
// Revised by the 2026-08-31 performance plan (Task 1.8): built-in tool
// ENTRIES are now registered eagerly, while heavy runtimes stay in
// dynamically-imported impl modules. The registry's lazy-loading machinery
// (ensureTool / preloadAllTools / pendingLoads dedup) is retained for
// non-eager manifest entries, so this file keeps exercising it through a
// synthetic manifest entry instead of a built-in.

import { describe, it, expect, vi } from 'vitest';
import { toolRegistry, registerBuiltInTools } from '../../src/tools';
import type { ToolDefinition } from '../../src/tools/protocol';

const loadToolModuleMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/tools/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/registry')>();
  return {
    ...actual,
    loadToolModule: loadToolModuleMock,
    // All real built-ins are eager after Task 1.8. Add a synthetic lazy entry
    // so the retained lazy-load path stays covered by behavior tests.
    TOOL_MANIFEST: [
      ...actual.TOOL_MANIFEST,
      {
        name: 'LazyProbe',
        modulePath: './LazyProbeTool/index.js',
        priority: actual.ToolPriority.LOW,
        eager: false,
      },
    ],
  };
});

function makeProbeTool(): ToolDefinition {
  return {
    name: 'LazyProbe',
    description: 'synthetic lazy probe',
    inputSchema: {},
    call: vi.fn(),
  };
}

describe('T22: eager registration with lazy runtime loading', () => {
  it('registers built-ins eagerly and leaves only non-eager manifest entries for lazy loading', async () => {
    await registerBuiltInTools();

    // Built-ins (incl. Sql, whose heavy better-sqlite3 runtime lives behind a
    // dynamic import) are registered without any preheat step.
    expect(toolRegistry.getTool('Sql')).toBeDefined();
    expect(toolRegistry.getLazyToolNames()).toEqual(['LazyProbe']);
    expect(toolRegistry.getTool('Bash')).toBeDefined();
  });

  it('shares one load when preheat and a first call race (pendingLoads dedup)', async () => {
    await registerBuiltInTools();
    const probe = makeProbeTool();
    loadToolModuleMock.mockResolvedValue(probe);

    const [viaFirstCall, viaPreheat] = await Promise.all([
      toolRegistry.ensureTool('LazyProbe'),
      toolRegistry.preloadAllTools().then(() => toolRegistry.ensureTool('LazyProbe')),
    ]);

    expect(viaFirstCall).toBeDefined();
    // Same instance — the concurrent callers joined the same load promise
    // instead of double-importing the module.
    expect(viaFirstCall).toBe(viaPreheat);
    expect(loadToolModuleMock).toHaveBeenCalledTimes(1);
    expect(toolRegistry.getLazyToolNames()).not.toContain('LazyProbe');
  });

  it('exposes the full tool set immediately, without a preheat step (prompt contract intact)', async () => {
    await registerBuiltInTools();

    const names = toolRegistry.getAllTools().map((t) => t.name);
    expect(names).toContain('Sql');
    expect(names).toContain('Bash');
  });
});
