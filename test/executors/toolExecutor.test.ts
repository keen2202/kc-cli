import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from '../../src/executors/toolExecutor';
import type { ToolDefinition, ToolUseContext } from '../../src/types/tools';
import type { ToolCall } from '../../src/types/message';

// Mock the permission engine
vi.mock('../../src/permissions/engine', () => ({
  hasPermissionsToUseTool: vi.fn().mockResolvedValue({ behavior: 'allow' }),
}));

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'TestTool',
    description: 'A test tool',
    inputSchema: {},
    call: vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: 'ok', isError: false }),
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolName: 'TestTool',
    input: { command: 'echo hello' },
    ...overrides,
  };
}

function makeContext(): ToolUseContext {
  return {
    cwd: '/tmp',
    permissions: {
      mode: 'default',
      cwd: '/tmp',
      toolName: '',
      input: {},
      bypassPermissions: false,
    },
    abortController: new AbortController(),
  };
}

describe('ToolExecutor', () => {
  describe('constructor', () => {
    it('should create executor with tools', () => {
      const executor = new ToolExecutor([makeTool()], '/tmp');
      expect(executor.hasTool('TestTool')).toBe(true);
    });

    it('should report unknown tools', () => {
      const executor = new ToolExecutor([], '/tmp');
      expect(executor.hasTool('Unknown')).toBe(false);
    });
  });

  describe('getRegisteredTools', () => {
    it('should list registered tool names', () => {
      const executor = new ToolExecutor([makeTool({ name: 'A' }), makeTool({ name: 'B' })], '/tmp');
      expect(executor.getRegisteredTools()).toEqual(['A', 'B']);
    });
  });

  describe('getTool', () => {
    it('should return tool by name', () => {
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp');
      expect(executor.getTool('TestTool')).toBe(tool);
    });

    it('should return undefined for unknown', () => {
      const executor = new ToolExecutor([], '/tmp');
      expect(executor.getTool('Unknown')).toBeUndefined();
    });
  });

  describe('executeSingle', () => {
    it('should execute a tool successfully', async () => {
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp');
      const result = await executor.executeSingle(makeToolCall(), makeContext());
      expect(result.isError).toBe(false);
      expect(result.output).toBe('ok');
    });

    it('should return error for unknown tool', async () => {
      const executor = new ToolExecutor([], '/tmp');
      const result = await executor.executeSingle(makeToolCall({ toolName: 'Unknown' }), makeContext());
      expect(result.isError).toBe(true);
      expect(result.output).toContain('Unknown tool');
    });

    it('should handle tool execution error', async () => {
      const tool = makeTool({
        call: vi.fn().mockRejectedValue(new Error('execution failed')),
      });
      const executor = new ToolExecutor([tool], '/tmp');
      const result = await executor.executeSingle(makeToolCall(), makeContext());
      expect(result.isError).toBe(true);
      expect(result.output).toContain('execution failed');
    });

    it('should call plugin preToolUse hook', async () => {
      const tool = makeTool();
      const preHook = vi.fn().mockResolvedValue({ modified: true });
      const executor = new ToolExecutor([tool], '/tmp', undefined, { preToolUse: preHook });
      await executor.executeSingle(makeToolCall(), makeContext());
      expect(preHook).toHaveBeenCalledWith('TestTool', { command: 'echo hello' }, expect.anything());
    });

    it('should block when preToolUse returns null', async () => {
      const tool = makeTool();
      const preHook = vi.fn().mockResolvedValue(null);
      const executor = new ToolExecutor([tool], '/tmp', undefined, { preToolUse: preHook });
      const result = await executor.executeSingle(makeToolCall(), makeContext());
      expect(result.isError).toBe(true);
      expect(result.output).toContain('blocked by plugin');
    });

    it('should call plugin postToolUse hook', async () => {
      const tool = makeTool();
      const postHook = vi.fn();
      const executor = new ToolExecutor([tool], '/tmp', undefined, { postToolUse: postHook });
      await executor.executeSingle(makeToolCall(), makeContext());
      expect(postHook).toHaveBeenCalled();
    });

    it('should handle preToolUse hook error gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tool = makeTool();
      const preHook = vi.fn().mockRejectedValue(new Error('hook error'));
      const executor = new ToolExecutor([tool], '/tmp', undefined, { preToolUse: preHook });
      const result = await executor.executeSingle(makeToolCall(), makeContext());
      expect(result.isError).toBe(false); // Should still execute
      consoleSpy.mockRestore();
    });

    it('should handle postToolUse hook error gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tool = makeTool();
      const postHook = vi.fn().mockRejectedValue(new Error('hook error'));
      const executor = new ToolExecutor([tool], '/tmp', undefined, { postToolUse: postHook });
      const result = await executor.executeSingle(makeToolCall(), makeContext());
      expect(result.isError).toBe(false);
      consoleSpy.mockRestore();
    });
  });

  describe('executeParallel', () => {
    it('should execute concurrent tools in parallel', async () => {
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp');
      const results = await executor.executeParallel(
        [makeToolCall({ id: 'tc1' }), makeToolCall({ id: 'tc2' })],
        makeContext()
      );
      expect(results.size).toBe(2);
      expect(results.get('tc1')).toBeDefined();
      expect(results.get('tc2')).toBeDefined();
    });

    it('should execute sequential tools one by one', async () => {
      const tool = makeTool({
        isConcurrencySafe: () => false,
      });
      const executor = new ToolExecutor([tool], '/tmp');
      const results = await executor.executeParallel(
        [makeToolCall({ id: 'tc1' }), makeToolCall({ id: 'tc2' })],
        makeContext()
      );
      expect(results.size).toBe(2);
    });

    it('should handle mixed concurrent and sequential tools', async () => {
      const concurrent = makeTool({ name: 'Concurrent' });
      const sequential = makeTool({ name: 'Sequential', isConcurrencySafe: () => false });
      const executor = new ToolExecutor([concurrent, sequential], '/tmp');
      const results = await executor.executeParallel(
        [makeToolCall({ id: 'tc1', toolName: 'Concurrent' }), makeToolCall({ id: 'tc2', toolName: 'Sequential' })],
        makeContext()
      );
      expect(results.size).toBe(2);
    });
  });

  describe('batchPermissionCheck', () => {
    it('should check permissions for all tools', async () => {
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp');
      const results = await executor.batchPermissionCheck([makeToolCall()], makeContext());
      expect(results).toHaveLength(1);
    });

    it('should deny unknown tools', async () => {
      const executor = new ToolExecutor([], '/tmp');
      const results = await executor.batchPermissionCheck([makeToolCall({ toolName: 'Unknown' })], makeContext());
      expect(results).toHaveLength(1);
      expect(results[0].behavior).toBe('deny');
    });
  });
});
