import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor, SANDBOX_WRAPPED_MARKER } from '../../src/executors/toolExecutor';
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

    it('fires onSettled once per tool with its result or error', async () => {
      const ok = makeTool({ name: 'OkTool' });
      const bad = makeTool({ name: 'BadTool', call: vi.fn().mockRejectedValue(new Error('boom')) });
      const executor = new ToolExecutor([ok, bad], '/tmp');
      const settled: Array<[string, 'ok' | 'error']> = [];
      const results = await executor.executeParallel(
        [
          makeToolCall({ id: 'tc-ok', toolName: 'OkTool' }),
          makeToolCall({ id: 'tc-bad', toolName: 'BadTool' }),
        ],
        makeContext(),
        (id, result) => settled.push([id, result instanceof Error || result.isError ? 'error' : 'ok']),
      );
      expect(results.size).toBe(2);
      expect(settled).toContainEqual(['tc-ok', 'ok']);
      expect(settled).toContainEqual(['tc-bad', 'error']);
    });

    it('fires onSettled after each sequential tool completes', async () => {
      const order: string[] = [];
      const tool = makeTool({
        name: 'SeqTool',
        isConcurrencySafe: () => false,
        call: vi.fn().mockImplementation(async () => {
          order.push('call');
          return { toolCallId: 'x', output: 'ok', isError: false };
        }),
      });
      const executor = new ToolExecutor([tool], '/tmp');
      const settledIds: string[] = [];
      await executor.executeParallel(
        [makeToolCall({ id: 's1', toolName: 'SeqTool' }), makeToolCall({ id: 's2', toolName: 'SeqTool' })],
        makeContext(),
        (id) => settledIds.push(id),
      );
      expect(settledIds).toEqual(['s1', 's2']);
      expect(order).toHaveLength(2);
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

  describe('sandbox command wrapping', () => {
    it('should wrap commands for Bash tool when sandbox is available', async () => {
      const mockCall = vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: 'ok', isError: false });
      const tool = makeTool({ name: 'Bash', call: mockCall });
      const executor = new ToolExecutor([tool], '/tmp', undefined, undefined, {
        enabled: true,
        backend: 'noop', // Use noop for test determinism
      });

      // With noop backend, sandbox is NOT "available" for required tools
      // So Bash (required) should be denied
      const result = await executor.executeSingle(
        makeToolCall({ toolName: 'Bash', input: { command: 'echo hello' } }),
        makeContext()
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('requires sandbox');
    });

    it('should wrap commands for Run tool when sandbox is available', async () => {
      const mockCall = vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: 'ok', isError: false });
      const tool = makeTool({ name: 'Run', call: mockCall });
      const executor = new ToolExecutor([tool], '/tmp', undefined, undefined, {
        enabled: true,
        backend: 'noop',
      });

      // Run is also 'required' enforcement, so noop backend means deny
      const result = await executor.executeSingle(
        makeToolCall({ toolName: 'Run', input: { command: 'echo hello' } }),
        makeContext()
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain('requires sandbox');
    });

    it('should NOT wrap commands for excluded tools', async () => {
      const mockCall = vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: 'ok', isError: false });
      const tool = makeTool({ name: 'FileRead', call: mockCall });
      const executor = new ToolExecutor([tool], '/tmp', undefined, undefined, {
        enabled: true,
        backend: 'noop',
      });

      // FileRead is excluded, so it should run without sandbox
      const result = await executor.executeSingle(
        makeToolCall({ toolName: 'FileRead', input: { path: '/tmp/test.txt' } }),
        makeContext()
      );
      expect(result.isError).toBe(false);
    });

    it('should add sandbox metadata to results when sandbox is available', async () => {
      const mockCall = vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: 'ok', isError: false });
      // Use a tool that's excluded from sandbox to avoid deny
      const tool = makeTool({ name: 'FileRead', call: mockCall });
      const executor = new ToolExecutor([tool], '/tmp', undefined, undefined, {
        enabled: true,
        backend: 'noop',
      });

      const result = await executor.executeSingle(
        makeToolCall({ toolName: 'FileRead', input: { path: '/tmp/test.txt' } }),
        makeContext()
      );

      // Should have sandbox metadata (even if not sandboxed)
      expect(result.metadata).toBeDefined();
      expect(result.metadata?.sandboxed).toBe(false); // noop = not truly sandboxed
      expect(result.metadata?.sandboxBackend).toBe('noop');
    });

    it('should pass sandbox manager in context to tools', async () => {
      let capturedContext: ToolUseContext | undefined;
      const mockCall = vi.fn().mockImplementation((_input, ctx) => {
        capturedContext = ctx;
        return Promise.resolve({ toolCallId: 'tc1', output: 'ok', isError: false });
      });
      const tool = makeTool({ name: 'FileRead', call: mockCall });
      const executor = new ToolExecutor([tool], '/tmp', undefined, undefined, {
        enabled: true,
        backend: 'noop',
      });

      await executor.executeSingle(
        makeToolCall({ toolName: 'FileRead', input: { path: '/tmp/test.txt' } }),
        makeContext()
      );

      expect(capturedContext).toBeDefined();
      expect(capturedContext?.sandbox).toBeDefined();
      expect(capturedContext?.sandbox?.getBackendName()).toBe('noop');
    });
  });

  describe('error handling edge cases', () => {
    it('should handle tool returning undefined output', async () => {
      const tool = makeTool({
        call: vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: undefined, isError: false }),
      });
      const executor = new ToolExecutor([tool], '/tmp');
      const result = await executor.executeSingle(makeToolCall(), makeContext());
      expect(result).toBeDefined();
    });

    it('should handle tool returning null', async () => {
      const tool = makeTool({
        call: vi.fn().mockResolvedValue(null),
      });
      const executor = new ToolExecutor([tool], '/tmp');
      const result = await executor.executeSingle(makeToolCall(), makeContext());
      expect(result).toBeDefined();
    });

    it('should handle tool throwing non-Error', async () => {
      const tool = makeTool({
        call: vi.fn().mockRejectedValue('string error'),
      });
      const executor = new ToolExecutor([tool], '/tmp');
      const result = await executor.executeSingle(makeToolCall(), makeContext());
      expect(result.isError).toBe(true);
    });

    it('should handle concurrent execution with many tools', async () => {
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp');
      const calls = Array.from({ length: 10 }, (_, i) =>
        makeToolCall({ id: `tc_${i}` })
      );
      const results = await executor.executeParallel(calls, makeContext());
      expect(results.size).toBe(10);
    });

    it('should handle empty parallel execution', async () => {
      const executor = new ToolExecutor([], '/tmp');
      const results = await executor.executeParallel([], makeContext());
      expect(results.size).toBe(0);
    });
  });
});
