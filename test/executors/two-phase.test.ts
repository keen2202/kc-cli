// Tests for two-phase tool execution pipeline (prepare/execute/finalize)
// Phase 2.4: Architecture optimization spec

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from '../../src/executors/toolExecutor';
import type { ToolDefinition, ToolUseContext, ToolResult } from '../../src/types/tools';
import type { ToolCall } from '../../src/types/message';

// Mock the permission engine to allow all by default
vi.mock('../../src/permissions/engine', () => ({
  hasPermissionsToUseTool: vi.fn().mockResolvedValue({ behavior: 'allow' }),
}));

// Mock logger to prevent noise in test output
vi.mock('../../src/services/logger', () => {
  const noop = vi.fn();
  const moduleLogger = { error: noop, warn: noop, info: noop, debug: noop };
  return {
    logger: {
      tools: moduleLogger,
      services: moduleLogger,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    },
    createLogger: () => moduleLogger,
  };
});

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'TestTool',
    description: 'A test tool',
    inputSchema: {},
    call: vi.fn().mockResolvedValue({
      toolCallId: 'tc1',
      output: 'original output',
      isError: false,
    }),
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    id: 'tc1',
    toolName: 'TestTool',
    input: { command: 'echo hello' },
    status: 'pending',
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

describe('Two-Phase Tool Execution Pipeline', () => {
  describe('ToolDefinition prepare/finalize type support', () => {
    it('should allow defining a tool with prepare and finalize', () => {
      const tool: ToolDefinition = {
        name: 'PhasedTool',
        description: 'Tool with prepare and finalize',
        inputSchema: {},
        call: vi.fn().mockResolvedValue({
          toolCallId: 'tc1',
          output: 'ok',
          isError: false,
        }),
        prepare: vi.fn().mockResolvedValue({ input: { command: 'echo hello' } }),
        finalize: vi.fn().mockImplementation(async (_input, result) => result),
      };

      expect(tool.prepare).toBeDefined();
      expect(tool.finalize).toBeDefined();
    });

    it('should allow defining a tool without prepare and finalize (backward compat)', () => {
      const tool = makeTool();
      expect(tool.prepare).toBeUndefined();
      expect(tool.finalize).toBeUndefined();
    });
  });

  describe('prepare phase', () => {
    it('should call tool prepare hook before execution', async () => {
      const prepareFn = vi.fn().mockResolvedValue({ input: { command: 'modified command' } });
      const callFn = vi.fn().mockResolvedValue({
        toolCallId: 'tc1',
        output: 'ok',
        isError: false,
      });
      const tool = makeTool({ prepare: prepareFn, call: callFn });
      const executor = new ToolExecutor([tool], '/tmp');

      await executor.executeSingle(makeToolCall(), makeContext());

      expect(prepareFn).toHaveBeenCalledWith(
        { command: 'echo hello' },
        expect.objectContaining({ cwd: '/tmp' })
      );
      // The tool's call should receive the modified input from prepare
      expect(callFn).toHaveBeenCalledWith(
        { command: 'modified command' },
        expect.objectContaining({ cwd: '/tmp' })
      );
    });

    it('should skip execution when prepare returns skip: true', async () => {
      const skipResult: ToolResult = {
        toolCallId: 'tc1',
        output: 'Skipped by prepare',
        isError: false,
      };
      const prepareFn = vi.fn().mockResolvedValue({
        input: { command: 'echo hello' },
        skip: true,
        result: skipResult,
      });
      const callFn = vi.fn().mockResolvedValue({
        toolCallId: 'tc1',
        output: 'should not be called',
        isError: false,
      });
      const tool = makeTool({ prepare: prepareFn, call: callFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.output).toBe('Skipped by prepare');
      expect(result.isError).toBe(false);
      expect(callFn).not.toHaveBeenCalled();
    });

    it('should use default skip result when prepare returns skip without result', async () => {
      const prepareFn = vi.fn().mockResolvedValue({
        input: { command: 'echo hello' },
        skip: true,
      });
      const callFn = vi.fn();
      const tool = makeTool({ prepare: prepareFn, call: callFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.output).toBe('Tool execution skipped by prepare hook');
      expect(result.isError).toBe(false);
      expect(callFn).not.toHaveBeenCalled();
    });

    it('should handle plugin preToolUse hook modifying input', async () => {
      const preHook = vi.fn().mockResolvedValue({ command: 'plugin modified' });
      const callFn = vi.fn().mockResolvedValue({
        toolCallId: 'tc1',
        output: 'ok',
        isError: false,
      });
      const tool = makeTool({ call: callFn });
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        preToolUse: preHook,
      });

      await executor.executeSingle(makeToolCall(), makeContext());

      expect(preHook).toHaveBeenCalledWith('TestTool', { command: 'echo hello' }, expect.anything());
      // The modified input should flow through to the tool
      expect(callFn).toHaveBeenCalledWith(
        { command: 'plugin modified' },
        expect.objectContaining({ cwd: '/tmp' })
      );
    });

    it('should block execution when plugin preToolUse returns null', async () => {
      const preHook = vi.fn().mockResolvedValue(null);
      const callFn = vi.fn();
      const tool = makeTool({ call: callFn });
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        preToolUse: preHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.isError).toBe(true);
      expect(result.output).toContain('blocked by plugin');
      expect(callFn).not.toHaveBeenCalled();
    });

    it('should run plugin preToolUse before tool prepare', async () => {
      const callOrder: string[] = [];
      const preHook = vi.fn().mockImplementation(async () => {
        callOrder.push('plugin-preToolUse');
        return { command: 'from plugin' };
      });
      const prepareFn = vi.fn().mockImplementation(async (input) => {
        callOrder.push('tool-prepare');
        return { input };
      });
      const callFn = vi.fn().mockImplementation(async () => {
        callOrder.push('tool-call');
        return { toolCallId: 'tc1', output: 'ok', isError: false };
      });

      const tool = makeTool({ prepare: prepareFn, call: callFn });
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        preToolUse: preHook,
      });

      await executor.executeSingle(makeToolCall(), makeContext());

      expect(callOrder).toEqual(['plugin-preToolUse', 'tool-prepare', 'tool-call']);
    });

    it('should handle tool prepare hook error gracefully', async () => {
      const prepareFn = vi.fn().mockRejectedValue(new Error('prepare failed'));
      const callFn = vi.fn().mockResolvedValue({
        toolCallId: 'tc1',
        output: 'ok',
        isError: false,
      });
      const tool = makeTool({ prepare: prepareFn, call: callFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      // Should still execute the tool despite prepare error
      expect(result.isError).toBe(false);
      expect(callFn).toHaveBeenCalled();
    });
  });

  describe('finalize phase', () => {
    it('should call tool finalize hook after execution', async () => {
      const finalizeFn = vi.fn().mockImplementation(async (_input, result) => ({
        ...result,
        output: 'finalized output',
      }));
      const tool = makeTool({ finalize: finalizeFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(finalizeFn).toHaveBeenCalledWith(
        { command: 'echo hello' },
        expect.objectContaining({ output: 'original output' }),
        expect.objectContaining({ cwd: '/tmp' })
      );
      expect(result.output).toBe('finalized output');
    });

    it('should call plugin postToolUse hook after tool finalize', async () => {
      const callOrder: string[] = [];
      const finalizeFn = vi.fn().mockImplementation(async (_input, result) => {
        callOrder.push('tool-finalize');
        return { ...result, output: 'after finalize' };
      });
      const postHook = vi.fn().mockImplementation(async (_name, _input, result) => {
        callOrder.push('plugin-postToolUse');
        return { ...result, output: 'after postHook' };
      });

      const tool = makeTool({ finalize: finalizeFn });
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        postToolUse: postHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(callOrder).toEqual(['tool-finalize', 'plugin-postToolUse']);
      // postToolUse result should override since it runs last
      expect(result.output).toBe('after postHook');
    });

    it('should use plugin postToolUse return value when non-null', async () => {
      const postHook = vi.fn().mockResolvedValue({
        toolCallId: 'tc1',
        output: 'modified by postHook',
        isError: false,
      });
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        postToolUse: postHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.output).toBe('modified by postHook');
    });

    it('should keep original result when postToolUse returns null', async () => {
      const postHook = vi.fn().mockResolvedValue(null);
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        postToolUse: postHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.output).toBe('original output');
    });

    it('should handle tool finalize hook error gracefully', async () => {
      const finalizeFn = vi.fn().mockRejectedValue(new Error('finalize failed'));
      const tool = makeTool({ finalize: finalizeFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      // Should still return the original result despite finalize error
      expect(result.isError).toBe(false);
      expect(result.output).toBe('original output');
    });

    it('should handle postToolUse hook error gracefully', async () => {
      const postHook = vi.fn().mockRejectedValue(new Error('postHook failed'));
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        postToolUse: postHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      // Should still return the original result despite postHook error
      expect(result.isError).toBe(false);
      expect(result.output).toBe('original output');
    });
  });

  describe('backward compatibility', () => {
    it('should execute tools without prepare/finalize exactly as before', async () => {
      const callFn = vi.fn().mockResolvedValue({
        toolCallId: 'tc1',
        output: 'simple result',
        isError: false,
      });
      const tool = makeTool({ call: callFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.isError).toBe(false);
      expect(result.output).toBe('simple result');
      expect(callFn).toHaveBeenCalledTimes(1);
    });

    it('should return error for unknown tools (same as before)', async () => {
      const executor = new ToolExecutor([], '/tmp');

      const result = await executor.executeSingle(
        makeToolCall({ toolName: 'Unknown' }),
        makeContext()
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain('Unknown tool');
    });

    it('should handle tool call rejection (same as before)', async () => {
      const tool = makeTool({
        call: vi.fn().mockRejectedValue(new Error('execution failed')),
      });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.isError).toBe(true);
      expect(result.output).toContain('execution failed');
    });

    it('should work with executeParallel (integration)', async () => {
      const prepareFn = vi.fn().mockResolvedValue({ input: { command: 'echo hello' } });
      const finalizeFn = vi.fn().mockImplementation(async (_input, result) => ({
        ...result,
        output: 'finalized',
      }));
      const tool = makeTool({ prepare: prepareFn, finalize: finalizeFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const results = await executor.executeParallel(
        [makeToolCall({ id: 'tc1' }), makeToolCall({ id: 'tc2' })],
        makeContext()
      );

      expect(results.size).toBe(2);
      const r1 = results.get('tc1') as ToolResult;
      const r2 = results.get('tc2') as ToolResult;
      expect(r1.output).toBe('finalized');
      expect(r2.output).toBe('finalized');
      expect(prepareFn).toHaveBeenCalledTimes(2);
      expect(finalizeFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('full pipeline integration', () => {
    it('should flow modified input through prepare -> execute -> finalize', async () => {
      const prepareFn = vi.fn().mockResolvedValue({
        input: { command: 'prepared command' },
      });
      const callFn = vi.fn().mockImplementation(async (input) => ({
        toolCallId: 'tc1',
        output: `executed: ${(input as Record<string, unknown>).command}`,
        isError: false,
      }));
      const finalizeFn = vi.fn().mockImplementation(async (_input, result) => ({
        ...result,
        output: `${result.output} -> finalized`,
      }));

      const tool = makeTool({ prepare: prepareFn, call: callFn, finalize: finalizeFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(prepareFn).toHaveBeenCalledWith(
        { command: 'echo hello' },
        expect.anything()
      );
      expect(callFn).toHaveBeenCalledWith(
        { command: 'prepared command' },
        expect.objectContaining({ cwd: '/tmp' })
      );
      expect(finalizeFn).toHaveBeenCalledWith(
        { command: 'prepared command' },
        expect.objectContaining({ output: 'executed: prepared command' }),
        expect.anything()
      );
      expect(result.output).toBe('executed: prepared command -> finalized');
    });

    it('should handle plugin hook modifying input, then tool prepare modifying it further', async () => {
      const preHook = vi.fn().mockResolvedValue({ command: 'plugin-modified' });
      const prepareFn = vi.fn().mockResolvedValue({
        input: { command: 'prepare-further-modified' },
      });
      const callFn = vi.fn().mockImplementation(async (input) => ({
        toolCallId: 'tc1',
        output: `ran: ${(input as Record<string, unknown>).command}`,
        isError: false,
      }));

      const tool = makeTool({ prepare: prepareFn, call: callFn });
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        preToolUse: preHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      // Plugin modifies first, then tool prepare modifies further
      expect(prepareFn).toHaveBeenCalledWith(
        { command: 'plugin-modified' },
        expect.anything()
      );
      expect(callFn).toHaveBeenCalledWith(
        { command: 'prepare-further-modified' },
        expect.anything()
      );
      expect(result.output).toBe('ran: prepare-further-modified');
    });

    it('should short-circuit on prepare skip and not call finalize', async () => {
      const prepareFn = vi.fn().mockResolvedValue({
        input: {},
        skip: true,
        result: { toolCallId: 'tc1', output: 'skipped', isError: false },
      });
      const callFn = vi.fn();
      const finalizeFn = vi.fn();

      const tool = makeTool({ prepare: prepareFn, call: callFn, finalize: finalizeFn });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.output).toBe('skipped');
      expect(callFn).not.toHaveBeenCalled();
      expect(finalizeFn).not.toHaveBeenCalled();
    });
  });
});
