import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plugin, PluginPermissionRule, PluginPrompt, PluginMCPConfig } from '../../src/plugins/types';

// Mock plugin-loader
vi.mock('../../src/plugins/plugin-loader', () => ({
  discoverPlugins: vi.fn(),
  loadPlugin: vi.fn(),
}));

// Mock postTurnHooks
vi.mock('../../src/hooks/postTurnHooks', () => ({
  registerPostTurnHook: vi.fn(),
}));

// Mock permission dependencies
vi.mock('../../src/bootstrap/state', () => ({
  getState: vi.fn().mockReturnValue({
    permissionMode: 'default',
    cwd: '/test',
  }),
}));

vi.mock('../../src/permissions/protectedPaths', () => ({
  containsProtectedPath: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/services/cache', () => ({
  getCacheManager: () => ({
    getOrCreate: () => ({
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
    }),
  }),
}));

import { PluginManager } from '../../src/plugins/plugin-manager';
import { discoverPlugins, loadPlugin } from '../../src/plugins/plugin-loader';
import { hasPermissionsToUseTool } from '../../src/permissions/engine';

const mockDiscoverPlugins = vi.mocked(discoverPlugins);
const mockLoadPlugin = vi.mocked(loadPlugin);

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Plugin Permission Rules', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  describe('getPluginPermissionRules', () => {
    it('collects permission rules from initialized plugins', async () => {
      const rules: PluginPermissionRule[] = [
        { toolPattern: 'Bash', behavior: 'deny', priority: 1 },
        { toolPattern: 'FileWrite', behavior: 'ask', priority: 2 },
      ];
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', permissionRules: rules })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      const result = manager.getPluginPermissionRules();
      expect(result).toHaveLength(2);
      expect(result[0].toolPattern).toBe('Bash');
      expect(result[1].toolPattern).toBe('FileWrite');
    });

    it('returns empty array when no plugins have permission rules', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a' }));

      await manager.loadAll('/project');
      await manager.initAll();

      expect(manager.getPluginPermissionRules()).toEqual([]);
    });

    it('returns empty array when no plugins are initialized', async () => {
      const rules: PluginPermissionRule[] = [
        { toolPattern: 'Bash', behavior: 'deny', priority: 1 },
      ];
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({
          name: 'a',
          permissionRules: rules,
          onInit: vi.fn().mockRejectedValue(new Error('init fail')),
        })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      expect(manager.getPluginPermissionRules()).toEqual([]);
    });

    it('sorts rules by priority (lower number = higher priority)', async () => {
      const rulesA: PluginPermissionRule[] = [
        { toolPattern: 'Bash', behavior: 'deny', priority: 10 },
      ];
      const rulesB: PluginPermissionRule[] = [
        { toolPattern: 'FileWrite', behavior: 'allow', priority: 1 },
      ];
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'a', permissionRules: rulesA }))
        .mockResolvedValueOnce(makePlugin({ name: 'b', permissionRules: rulesB }));

      await manager.loadAll('/project');
      await manager.initAll();

      const result = manager.getPluginPermissionRules();
      expect(result).toHaveLength(2);
      expect(result[0].priority).toBe(1);
      expect(result[0].toolPattern).toBe('FileWrite');
      expect(result[1].priority).toBe(10);
      expect(result[1].toolPattern).toBe('Bash');
    });

    it('collects rules from multiple plugins', async () => {
      const rulesA: PluginPermissionRule[] = [
        { toolPattern: 'Bash', behavior: 'deny', priority: 1 },
      ];
      const rulesB: PluginPermissionRule[] = [
        { toolPattern: '*', behavior: 'ask', priority: 100 },
      ];
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'a', permissionRules: rulesA }))
        .mockResolvedValueOnce(makePlugin({ name: 'b', permissionRules: rulesB }));

      await manager.loadAll('/project');
      await manager.initAll();

      const result = manager.getPluginPermissionRules();
      expect(result).toHaveLength(2);
    });
  });
});

describe('Plugin Permission Rules in Engine', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  it('applies plugin deny rule when tool matches', async () => {
    const rules: PluginPermissionRule[] = [
      { toolPattern: 'Bash', behavior: 'deny', priority: 1 },
    ];
    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(
      makePlugin({ name: 'a', permissionRules: rules })
    );

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await hasPermissionsToUseTool('Bash', { command: 'ls' }, {
      pluginManager: manager,
    });

    expect(result.behavior).toBe('deny');
    expect(result.decisionReason?.type).toBe('plugin_rule');
  });

  it('applies plugin allow rule when tool matches', async () => {
    const rules: PluginPermissionRule[] = [
      { toolPattern: 'FileRead', behavior: 'allow', priority: 1 },
    ];
    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(
      makePlugin({ name: 'a', permissionRules: rules })
    );

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await hasPermissionsToUseTool('FileRead', { path: '/tmp/test.txt' }, {
      pluginManager: manager,
    });

    expect(result.behavior).toBe('allow');
    expect(result.decisionReason?.type).toBe('plugin_rule');
  });

  it('applies plugin ask rule when tool matches', async () => {
    const rules: PluginPermissionRule[] = [
      { toolPattern: 'FileWrite', behavior: 'ask', priority: 1 },
    ];
    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(
      makePlugin({ name: 'a', permissionRules: rules })
    );

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await hasPermissionsToUseTool('FileWrite', { path: '/tmp/test.txt' }, {
      pluginManager: manager,
    });

    expect(result.behavior).toBe('ask');
    expect(result.decisionReason?.type).toBe('plugin_rule');
  });

  it('applies wildcard plugin rule to all tools', async () => {
    const rules: PluginPermissionRule[] = [
      { toolPattern: '*', behavior: 'ask', priority: 1 },
    ];
    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(
      makePlugin({ name: 'a', permissionRules: rules })
    );

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await hasPermissionsToUseTool('AnyTool', { data: 'test' }, {
      pluginManager: manager,
    });

    expect(result.behavior).toBe('ask');
    expect(result.decisionReason?.type).toBe('plugin_rule');
  });

  it('respects content pattern matching', async () => {
    const rules: PluginPermissionRule[] = [
      { toolPattern: 'Bash', contentPattern: 'rm -rf *', behavior: 'deny', priority: 1 },
    ];
    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(
      makePlugin({ name: 'a', permissionRules: rules })
    );

    await manager.loadAll('/project');
    await manager.initAll();

    // Matching content
    const result1 = await hasPermissionsToUseTool('Bash', { command: 'rm -rf /tmp' }, {
      pluginManager: manager,
      content: 'rm -rf /tmp',
    });
    expect(result1.behavior).toBe('deny');

    // Non-matching content
    const result2 = await hasPermissionsToUseTool('Bash', { command: 'ls -la' }, {
      pluginManager: manager,
      content: 'ls -la',
    });
    expect(result2.behavior).not.toBe('deny');
  });

  it('plugin rules run after global deny but before tool-specific check', async () => {
    const rules: PluginPermissionRule[] = [
      { toolPattern: 'Bash', behavior: 'allow', priority: 1 },
    ];
    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(
      makePlugin({ name: 'a', permissionRules: rules })
    );

    await manager.loadAll('/project');
    await manager.initAll();

    // Plugin allow should not override global deny (global deny is Step 1, plugin is Step 1.5)
    const result = await hasPermissionsToUseTool('Bash', { command: 'ls' }, {
      pluginManager: manager,
      config: { alwaysDenyRules: ['Bash'] },
    });

    // Global deny takes precedence over plugin allow
    expect(result.behavior).toBe('deny');
    expect(result.decisionReason?.type).toBe('policy_deny');
  });

  it('works without pluginManager (non-breaking)', async () => {
    const result = await hasPermissionsToUseTool('Bash', { command: 'ls' }, {});
    // Should proceed through normal permission flow without error
    expect(result).toBeDefined();
    expect(result.behavior).toBeDefined();
  });
});

describe('Plugin Prompt Validation', () => {
  it('validates prompts with required fields', () => {
    const prompts: PluginPrompt[] = [
      { name: 'test-prompt', template: 'Hello {{name}}', description: 'A test prompt' },
    ];
    expect(prompts[0].name).toBe('test-prompt');
    expect(prompts[0].template).toBe('Hello {{name}}');
  });

  it('supports optional args', () => {
    const prompts: PluginPrompt[] = [
      {
        name: 'greeting',
        template: 'Hello {{name}}, you are {{age}} years old',
        description: 'Greeting prompt',
        args: {
          name: { type: 'string', description: 'User name', required: true },
          age: { type: 'number', description: 'User age' },
        },
      },
    ];
    expect(prompts[0].args?.name.required).toBe(true);
    expect(prompts[0].args?.age.required).toBeUndefined();
  });
});

describe('Plugin MCP Config Validation', () => {
  it('validates MCP config with required fields', () => {
    const configs: PluginMCPConfig[] = [
      { serverId: 'my-server', command: 'node', args: ['server.js'] },
    ];
    expect(configs[0].serverId).toBe('my-server');
    expect(configs[0].command).toBe('node');
    expect(configs[0].args).toEqual(['server.js']);
  });

  it('supports optional env', () => {
    const configs: PluginMCPConfig[] = [
      {
        serverId: 'my-server',
        command: 'node',
        env: { NODE_ENV: 'production' },
      },
    ];
    expect(configs[0].env?.NODE_ENV).toBe('production');
  });
});
