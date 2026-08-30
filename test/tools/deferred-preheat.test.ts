// T22 (P1): tool module loading must not sit on the serial startup path — round4 §5-P1
//
// In this test file's isolated module registry, src/tools.ts starts fresh, so
// these assertions prove the *laziness contract*: eager registration does not
// import the deferred modules, and a concurrent preload/ensureTool pair share
// one load via pendingLoads (the invariant T23's background preheat relies on).

import { describe, it, expect } from 'vitest';
import { toolRegistry, registerBuiltInTools } from '../../src/tools';

describe('T22: deferred tool loading', () => {
  it('does not load lazy tool modules during eager registration', async () => {
    await registerBuiltInTools();

    // The deferred modules (incl. Sql → better-sqlite3) were NOT imported:
    // the tool is only a manifest entry, not a registered definition.
    expect(toolRegistry.getTool('Sql')).toBeUndefined();
    expect(toolRegistry.getLazyToolNames()).toContain('Sql');
    // Eager tools, by contrast, are present immediately.
    expect(toolRegistry.getTool('Bash')).toBeDefined();
  });

  it('shares one load when preheat and a first call race (pendingLoads dedup)', async () => {
    await registerBuiltInTools();

    const [viaFirstCall, viaPreheat] = await Promise.all([
      toolRegistry.ensureTool('Sql'),
      toolRegistry.preloadAllTools().then(() => toolRegistry.ensureTool('Sql')),
    ]);

    expect(viaFirstCall).toBeDefined();
    // Same instance — the concurrent callers joined the same load promise
    // instead of double-importing the module.
    expect(viaFirstCall).toBe(viaPreheat);
    expect(toolRegistry.getLazyToolNames()).not.toContain('Sql');
  });

  it('exposes the full tool set once preheat completes (prompt contract intact)', async () => {
    await registerBuiltInTools();
    await toolRegistry.preloadAllTools();

    const names = toolRegistry.getAllTools().map((t) => t.name);
    expect(names).toContain('Sql');
    expect(names).toContain('Bash');
  });
});
