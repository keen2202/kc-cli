import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plugin } from '../../src/plugins/types';

// Mock plugin-loader
vi.mock('../../src/plugins/plugin-loader', () => ({
  discoverPlugins: vi.fn(),
  loadPlugin: vi.fn(),
}));

// Mock postTurnHooks
vi.mock('../../src/hooks/postTurnHooks', () => ({
  registerPostTurnHook: vi.fn(),
}));

import { PluginManager } from '../../src/plugins/plugin-manager';
import { discoverPlugins, loadPlugin } from '../../src/plugins/plugin-loader';
import { registerPostTurnHook } from '../../src/hooks/postTurnHooks';

const mockDiscoverPlugins = vi.mocked(discoverPlugins);
const mockLoadPlugin = vi.mocked(loadPlugin);
const mockRegisterPostTurnHook = vi.mocked(registerPostTurnHook);

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

describe('PluginManager', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  describe('loadAll', () => {
    it('discovers and loads plugins from the project dir', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'plugin-a' }))
        .mockResolvedValueOnce(makePlugin({ name: 'plugin-b' }));

      await manager.loadAll('/project');

      expect(mockDiscoverPlugins).toHaveBeenCalledWith('/project');
      expect(mockLoadPlugin).toHaveBeenCalledWith('/plugins/a');
      expect(mockLoadPlugin).toHaveBeenCalledWith('/plugins/b');
      expect(manager.getLoadedPlugins()).toHaveLength(2);
    });

    it('skips directories where loadPlugin returns null', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(makePlugin({ name: 'plugin-b' }));

      await manager.loadAll('/project');

      const plugins = manager.getLoadedPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('plugin-b');
      expect(plugins[0].status).toBe('loaded');
    });

    it('silently skips plugins that throw during load', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockRejectedValueOnce(new Error('load crash'))
        .mockResolvedValueOnce(makePlugin({ name: 'plugin-b' }));

      await manager.loadAll('/project');

      const plugins = manager.getLoadedPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('plugin-b');
    });
  });

  describe('initAll', () => {
    it('calls onInit for each loaded plugin', async () => {
      const onInitA = vi.fn().mockResolvedValue(undefined);
      const onInitB = vi.fn().mockResolvedValue(undefined);
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'a', onInit: onInitA }))
        .mockResolvedValueOnce(makePlugin({ name: 'b', onInit: onInitB }));

      await manager.loadAll('/project');
      await manager.initAll();

      expect(onInitA).toHaveBeenCalled();
      expect(onInitB).toHaveBeenCalled();

      const plugins = manager.getLoadedPlugins();
      expect(plugins.map(p => p.status)).toEqual(['initialized', 'initialized']);
    });

    it('registers postTurn hooks from plugins', async () => {
      const postTurn = vi.fn().mockResolvedValue(undefined);
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', hooks: { postTurn } })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      expect(mockRegisterPostTurnHook).toHaveBeenCalledTimes(1);
    });

    it('sets status to error when onInit throws', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', onInit: vi.fn().mockRejectedValue(new Error('init fail')) })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      const plugins = manager.getLoadedPlugins();
      expect(plugins[0].status).toBe('error');
      expect(plugins[0].error).toBe('init fail');
    });

    it('sets error string when non-Error is thrown', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', onInit: vi.fn().mockRejectedValue('string error') })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      const plugins = manager.getLoadedPlugins();
      expect(plugins[0].status).toBe('error');
      expect(plugins[0].error).toBe('string error');
    });

    it('skips plugins not in loaded status', async () => {
      const onInit = vi.fn().mockRejectedValue(new Error('fail'));
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', onInit })
      );

      await manager.loadAll('/project');
      await manager.initAll(); // This sets it to 'error'
      onInit.mockClear();

      // Calling initAll again should skip the errored plugin
      await manager.initAll();
      expect(onInit).not.toHaveBeenCalled();
    });
  });

  describe('shutdownAll', () => {
    it('calls onShutdown for initialized plugins', async () => {
      const onShutdown = vi.fn().mockResolvedValue(undefined);
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', onShutdown })
      );

      await manager.loadAll('/project');
      await manager.initAll();
      await manager.shutdownAll();

      expect(onShutdown).toHaveBeenCalled();
    });

    it('skips shutdown for non-initialized plugins', async () => {
      const onShutdown = vi.fn().mockResolvedValue(undefined);
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({
          name: 'a',
          onShutdown,
          onInit: vi.fn().mockRejectedValue(new Error('fail')),
        })
      );

      await manager.loadAll('/project');
      await manager.initAll(); // fails -> status 'error'
      await manager.shutdownAll();

      expect(onShutdown).not.toHaveBeenCalled();
    });

    it('times out shutdown after 5 seconds', async () => {
      vi.useFakeTimers();
      const onShutdown = vi.fn().mockImplementation(
        () => new Promise(() => {}) // never resolves
      );
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', onShutdown })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      const shutdownPromise = manager.shutdownAll();
      vi.advanceTimersByTime(5001);
      await shutdownPromise; // should resolve despite hanging onShutdown

      vi.useRealTimers();
    });

    it('ignores errors during shutdown', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', onShutdown: vi.fn().mockRejectedValue(new Error('shutdown fail')) })
      );

      await manager.loadAll('/project');
      await manager.initAll();
      await manager.shutdownAll(); // Should not throw
    });
  });

  describe('getPluginTools', () => {
    it('returns tools from initialized plugins', async () => {
      const tool = {
        name: 'custom-tool',
        description: 'A custom tool',
        inputSchema: {} as any,
        call: vi.fn(),
      };
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', tools: [tool] })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      const tools = manager.getPluginTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('custom-tool');
    });

    it('does not return tools from non-initialized plugins', async () => {
      const tool = {
        name: 'custom-tool',
        description: 'A custom tool',
        inputSchema: {} as any,
        call: vi.fn(),
      };
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', tools: [tool], onInit: vi.fn().mockRejectedValue(new Error('fail')) })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      const tools = manager.getPluginTools();
      expect(tools).toHaveLength(0);
    });

    it('applies default isConcurrencySafe and isReadOnly', async () => {
      const tool = {
        name: 'raw-tool',
        description: 'Raw tool',
        inputSchema: {} as any,
        call: vi.fn(),
      };
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', tools: [tool] })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      const tools = manager.getPluginTools();
      expect(tools[0].isConcurrencySafe!({})).toBe(false);
      expect(tools[0].isReadOnly!({})).toBe(false);
    });

    it('preserves existing isConcurrencySafe and isReadOnly', async () => {
      const tool = {
        name: 'classified-tool',
        description: 'Classified tool',
        inputSchema: {} as any,
        call: vi.fn(),
        isConcurrencySafe: () => true,
        isReadOnly: () => true,
      };
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(
        makePlugin({ name: 'a', tools: [tool] })
      );

      await manager.loadAll('/project');
      await manager.initAll();

      const tools = manager.getPluginTools();
      expect(tools[0].isConcurrencySafe!({})).toBe(true);
      expect(tools[0].isReadOnly!({})).toBe(true);
    });
  });

  describe('getPluginHooks', () => {
    it('merges hooks from multiple plugins', async () => {
      const preToolUse1 = vi.fn().mockResolvedValue({ modified: true });
      const preToolUse2 = vi.fn().mockResolvedValue({ modified2: true });
      const postToolUse1 = vi.fn().mockResolvedValue(undefined);
      const postToolUse2 = vi.fn().mockResolvedValue(undefined);
      const postTurn1 = vi.fn().mockResolvedValue(undefined);
      const postTurn2 = vi.fn().mockResolvedValue(undefined);

      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({
          name: 'a',
          hooks: { preToolUse: preToolUse1, postToolUse: postToolUse1, postTurn: postTurn1 },
        }))
        .mockResolvedValueOnce(makePlugin({
          name: 'b',
          hooks: { preToolUse: preToolUse2, postToolUse: postToolUse2, postTurn: postTurn2 },
        }));

      await manager.loadAll('/project');
      await manager.initAll();

      const hooks = manager.getPluginHooks();
      expect(hooks.preToolUse).toBeDefined();
      expect(hooks.postToolUse).toBeDefined();
      expect(hooks.postTurn).toBeDefined();
    });

    it('returns empty hooks when no plugins have hooks', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a' }));

      await manager.loadAll('/project');
      await manager.initAll();

      const hooks = manager.getPluginHooks();
      expect(hooks.preToolUse).toBeUndefined();
      expect(hooks.postToolUse).toBeUndefined();
      expect(hooks.postTurn).toBeUndefined();
    });

    it('chains preToolUse hooks: second receives output of first', async () => {
      const hook1 = vi.fn().mockResolvedValue({ step1: true });
      const hook2 = vi.fn().mockResolvedValue({ step2: true });

      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { preToolUse: hook1 } }))
        .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { preToolUse: hook2 } }));

      await manager.loadAll('/project');
      await manager.initAll();

      const hooks = manager.getPluginHooks();
      const result = await hooks.preToolUse!('tool', { input: true }, {} as any);

      expect(hook1).toHaveBeenCalledWith('tool', { input: true }, expect.anything());
      expect(hook2).toHaveBeenCalledWith('tool', { step1: true }, expect.anything());
      expect(result).toEqual({ step2: true });
    });

    it('chains preToolUse: stops if first hook returns null', async () => {
      const hook1 = vi.fn().mockResolvedValue(null);
      const hook2 = vi.fn().mockResolvedValue({ step2: true });

      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { preToolUse: hook1 } }))
        .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { preToolUse: hook2 } }));

      await manager.loadAll('/project');
      await manager.initAll();

      const hooks = manager.getPluginHooks();
      const result = await hooks.preToolUse!('tool', { input: true }, {} as any);

      expect(hook1).toHaveBeenCalled();
      expect(hook2).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });

    it('chains postToolUse hooks sequentially', async () => {
      const order: string[] = [];
      const hook1 = vi.fn().mockImplementation(async () => { order.push('a'); });
      const hook2 = vi.fn().mockImplementation(async () => { order.push('b'); });

      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { postToolUse: hook1 } }))
        .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { postToolUse: hook2 } }));

      await manager.loadAll('/project');
      await manager.initAll();

      const hooks = manager.getPluginHooks();
      await hooks.postToolUse!('tool', {}, 'result', {} as any);

      expect(order).toEqual(['a', 'b']);
    });

    it('chains postTurn hooks sequentially', async () => {
      const order: string[] = [];
      const hook1 = vi.fn().mockImplementation(async () => { order.push('a'); });
      const hook2 = vi.fn().mockImplementation(async () => { order.push('b'); });

      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { postTurn: hook1 } }))
        .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { postTurn: hook2 } }));

      await manager.loadAll('/project');
      await manager.initAll();

      const hooks = manager.getPluginHooks();
      await hooks.postTurn!([]);

      expect(order).toEqual(['a', 'b']);
    });

    it('skips non-initialized plugins when merging hooks', async () => {
      const hook = vi.fn().mockResolvedValue(undefined);

      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(makePlugin({
        name: 'a',
        hooks: { preToolUse: hook },
        onInit: vi.fn().mockRejectedValue(new Error('fail')),
      }));

      await manager.loadAll('/project');
      await manager.initAll();

      const hooks = manager.getPluginHooks();
      expect(hooks.preToolUse).toBeUndefined();
    });
  });

  describe('getLoadedPlugins', () => {
    it('returns name, version, status for each plugin', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
      mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a', version: '2.0.0' }));

      await manager.loadAll('/project');

      const list = manager.getLoadedPlugins();
      expect(list).toEqual([
        { name: 'a', version: '2.0.0', status: 'loaded', error: undefined },
      ]);
    });

    it('returns empty array when no plugins loaded', () => {
      expect(manager.getLoadedPlugins()).toEqual([]);
    });
  });

  describe('error isolation', () => {
    it('one plugin load failure does not prevent loading others', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b', '/plugins/c']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({ name: 'a' }))
        .mockRejectedValueOnce(new Error('crash'))
        .mockResolvedValueOnce(makePlugin({ name: 'c' }));

      await manager.loadAll('/project');

      const plugins = manager.getLoadedPlugins();
      expect(plugins).toHaveLength(2);
      expect(plugins.map(p => p.name)).toEqual(['a', 'c']);
    });

    it('one plugin init failure does not prevent initializing others', async () => {
      mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
      mockLoadPlugin
        .mockResolvedValueOnce(makePlugin({
          name: 'a',
          onInit: vi.fn().mockRejectedValue(new Error('init fail')),
        }))
        .mockResolvedValueOnce(makePlugin({ name: 'b' }));

      await manager.loadAll('/project');
      await manager.initAll();

      const plugins = manager.getLoadedPlugins();
      expect(plugins.find(p => p.name === 'a')!.status).toBe('error');
      expect(plugins.find(p => p.name === 'b')!.status).toBe('initialized');
    });
  });
});
