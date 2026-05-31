import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Plugin } from '../../src/plugins/types';
import type { ChatMessage } from '../../src/types/message';
import type { ToolUseContext, ToolResult } from '../../src/types/tools';

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

const mockDiscoverPlugins = vi.mocked(discoverPlugins);
const mockLoadPlugin = vi.mocked(loadPlugin);

function makePlugin(overrides: Partial<Plugin> = {}): Plugin {
  return {
    name: 'test-plugin',
    version: '1.0.0',
    ...overrides,
  };
}

function makeContext(): ToolUseContext {
  return {
    cwd: '/test',
    abortController: new AbortController(),
    permissions: { rules: [] } as any,
  };
}

function makeChatMessage(role: 'user' | 'assistant' | 'system', content: string): ChatMessage {
  return {
    id: `msg-${Date.now()}-${Math.random()}`,
    role,
    content,
    timestamp: Date.now(),
  } as ChatMessage;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Plugin Hooks - preTurn', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  it('modifies messages when preTurn hook returns non-null', async () => {
    const original = [makeChatMessage('user', 'hello')];
    const modified = [makeChatMessage('user', 'hello'), makeChatMessage('system', 'injected')];

    const preTurn = vi.fn().mockResolvedValue(modified);
    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { preTurn } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executePreTurnHooks(original, makeContext());

    expect(preTurn).toHaveBeenCalledWith(original, expect.anything());
    expect(result).toEqual(modified);
  });

  it('returns original messages when preTurn hook returns null', async () => {
    const original = [makeChatMessage('user', 'hello')];
    const preTurn = vi.fn().mockResolvedValue(null);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { preTurn } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executePreTurnHooks(original, makeContext());

    expect(preTurn).toHaveBeenCalled();
    expect(result).toEqual(original);
  });

  it('returns original messages when no preTurn hooks are registered', async () => {
    const original = [makeChatMessage('user', 'hello')];

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a' }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executePreTurnHooks(original, makeContext());

    expect(result).toEqual(original);
  });

  it('chains preTurn hooks: second receives modified messages from first', async () => {
    const original = [makeChatMessage('user', 'hello')];
    const afterFirst = [makeChatMessage('user', 'hello'), makeChatMessage('system', 'from-a')];
    const afterSecond = [makeChatMessage('user', 'hello'), makeChatMessage('system', 'from-a'), makeChatMessage('system', 'from-b')];

    const hookA = vi.fn().mockResolvedValue(afterFirst);
    const hookB = vi.fn().mockResolvedValue(afterSecond);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
    mockLoadPlugin
      .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { preTurn: hookA } }))
      .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { preTurn: hookB } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executePreTurnHooks(original, makeContext());

    expect(hookA).toHaveBeenCalledWith(original, expect.anything());
    expect(hookB).toHaveBeenCalledWith(afterFirst, expect.anything());
    expect(result).toEqual(afterSecond);
  });

  it('chains preTurn hooks: null from first passes original to second', async () => {
    const original = [makeChatMessage('user', 'hello')];
    const afterSecond = [makeChatMessage('user', 'hello'), makeChatMessage('system', 'from-b')];

    const hookA = vi.fn().mockResolvedValue(null);
    const hookB = vi.fn().mockResolvedValue(afterSecond);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
    mockLoadPlugin
      .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { preTurn: hookA } }))
      .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { preTurn: hookB } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executePreTurnHooks(original, makeContext());

    // hookA returns null, so hookB should receive original messages
    expect(hookA).toHaveBeenCalledWith(original, expect.anything());
    expect(hookB).toHaveBeenCalledWith(original, expect.anything());
    expect(result).toEqual(afterSecond);
  });
});

describe('Plugin Hooks - onError', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  it('swallows error when onError hook returns null', async () => {
    const error = new Error('test error');
    const onError = vi.fn().mockResolvedValue(null);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { onError } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executeOnErrorHooks(error, makeContext());

    expect(onError).toHaveBeenCalledWith(error, expect.anything());
    expect(result).toBeNull();
  });

  it('returns modified error when onError hook returns non-null', async () => {
    const original = new Error('original');
    const modified = new Error('modified');
    const onError = vi.fn().mockResolvedValue(modified);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { onError } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executeOnErrorHooks(original, makeContext());

    expect(onError).toHaveBeenCalledWith(original, expect.anything());
    expect(result).toEqual(modified);
  });

  it('returns original error when no onError hooks are registered', async () => {
    const error = new Error('test');

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a' }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executeOnErrorHooks(error, makeContext());

    expect(result).toEqual(error);
  });

  it('chains onError hooks: second receives modified error from first', async () => {
    const original = new Error('original');
    const afterFirst = new Error('first-modified');
    const afterSecond = new Error('second-modified');

    const hookA = vi.fn().mockResolvedValue(afterFirst);
    const hookB = vi.fn().mockResolvedValue(afterSecond);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
    mockLoadPlugin
      .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { onError: hookA } }))
      .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { onError: hookB } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executeOnErrorHooks(original, makeContext());

    expect(hookA).toHaveBeenCalledWith(original, expect.anything());
    expect(hookB).toHaveBeenCalledWith(afterFirst, expect.anything());
    expect(result).toEqual(afterSecond);
  });

  it('chains onError hooks: null from first swallows error before second', async () => {
    const original = new Error('original');
    const hookA = vi.fn().mockResolvedValue(null);
    const hookB = vi.fn().mockResolvedValue(new Error('should not reach'));

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
    mockLoadPlugin
      .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { onError: hookA } }))
      .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { onError: hookB } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executeOnErrorHooks(original, makeContext());

    expect(hookA).toHaveBeenCalled();
    expect(hookB).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('Plugin Hooks - postToolUse with return value', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  it('chains postToolUse hooks and returns modified result', async () => {
    const originalResult: ToolResult = { output: 'original', isError: false };
    const modifiedResult: ToolResult = { output: 'modified', isError: false };

    const hook = vi.fn().mockResolvedValue(modifiedResult);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { postToolUse: hook } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const hooks = manager.getPluginHooks();
    const result = await hooks.postToolUse!('tool', {}, originalResult, makeContext());

    expect(hook).toHaveBeenCalledWith('tool', {}, originalResult, expect.anything());
    expect(result).toEqual(modifiedResult);
  });

  it('chains postToolUse: null from first passes original to second', async () => {
    const originalResult: ToolResult = { output: 'original', isError: false };
    const modifiedResult: ToolResult = { output: 'modified-by-b', isError: false };

    const hookA = vi.fn().mockResolvedValue(null);
    const hookB = vi.fn().mockResolvedValue(modifiedResult);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a', '/plugins/b']);
    mockLoadPlugin
      .mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { postToolUse: hookA } }))
      .mockResolvedValueOnce(makePlugin({ name: 'b', hooks: { postToolUse: hookB } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const hooks = manager.getPluginHooks();
    const result = await hooks.postToolUse!('tool', {}, originalResult, makeContext());

    expect(hookA).toHaveBeenCalledWith('tool', {}, originalResult, expect.anything());
    // hookA returned null, so hookB should receive originalResult
    expect(hookB).toHaveBeenCalledWith('tool', {}, originalResult, expect.anything());
    expect(result).toEqual(modifiedResult);
  });
});

describe('Plugin Hooks - null return (no modification)', () => {
  let manager: PluginManager;

  beforeEach(() => {
    manager = new PluginManager();
  });

  it('preTurn returning null preserves original messages', async () => {
    const messages = [makeChatMessage('user', 'test')];
    const preTurn = vi.fn().mockResolvedValue(null);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { preTurn } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executePreTurnHooks(messages, makeContext());
    expect(result).toBe(messages); // Same reference
  });

  it('onError returning null swallows error', async () => {
    const error = new Error('swallowed');
    const onError = vi.fn().mockResolvedValue(null);

    mockDiscoverPlugins.mockResolvedValue(['/plugins/a']);
    mockLoadPlugin.mockResolvedValueOnce(makePlugin({ name: 'a', hooks: { onError } }));

    await manager.loadAll('/project');
    await manager.initAll();

    const result = await manager.executeOnErrorHooks(error, makeContext());
    expect(result).toBeNull();
  });
});
