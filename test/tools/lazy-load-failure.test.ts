// Behavior tests for tool lazy-load failure visibility.
// Verifies that load failures are logged instead of being silently swallowed
// at both layers: src/tools/registry.ts loadToolModule (import/extract failure)
// and src/tools.ts ensureTool (load returned undefined).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { logger } from '../../src/services/logger';
import { ToolPriority, type ToolManifestEntry } from '../../src/tools/registry';

const loadToolModuleMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/tools/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/registry')>();
  return { ...actual, loadToolModule: loadToolModuleMock };
});

// Imported after vi.mock so ensureTool uses the mocked loadToolModule
import { toolRegistry } from '../../src/tools';

afterEach(() => {
  vi.restoreAllMocks();
  loadToolModuleMock.mockReset();
});

describe('loadToolModule failure logging', () => {
  it('logs module path and error reason on import failure, and returns undefined', async () => {
    const warnSpy = vi.spyOn(logger.tools, 'warn').mockImplementation(() => {});
    // Bypass the module mock to exercise the real implementation
    const actual = await vi.importActual<typeof import('../../src/tools/registry')>(
      '../../src/tools/registry'
    );
    const entry: ToolManifestEntry = {
      name: 'Broken',
      modulePath: './BrokenTool/index.js',
      priority: ToolPriority.LOW,
    };

    const result = await actual.loadToolModule(entry);

    expect(result).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Broken'),
      expect.objectContaining({
        modulePath: './BrokenTool/index.js',
        error: expect.any(String),
      })
    );
  });
});

describe('ensureTool failure logging', () => {
  it('warns and returns undefined when lazy load yields no tool definition', async () => {
    const warnSpy = vi.spyOn(logger.tools, 'warn').mockImplementation(() => {});
    loadToolModuleMock.mockResolvedValueOnce(undefined);

    const result = await toolRegistry.ensureTool('Sql');

    expect(result).toBeUndefined();
    expect(loadToolModuleMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Sql'),
      expect.objectContaining({ modulePath: './SqlTool/index.js' })
    );
    // Failure must not consume the manifest entry — the tool stays retryable
    expect(toolRegistry.getLazyToolNames()).toContain('Sql');
  });
});
