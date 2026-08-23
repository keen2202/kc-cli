// Behavior tests for the tool execution pipeline's plugin hooks.
//
// Execution model (post audit-remediation-round3 T01): a tool runs as
// call + permission check + plugin hooks (preToolUse / postToolUse). The
// former `(tool as any).prepare/.finalize` probe paths were dead code
// (no ToolDefinition declares them) and have been removed — these tests
// pin down the hook semantics that actually exist:
//   input  flow : preToolUse may modify input or block by returning null
//   result flow : postToolUse may override a non-null result
//   resilience  : hook errors never break execution

import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor } from '../../src/executors/toolExecutor';
import type { ToolDefinition, ToolUseContext, ToolResult } from '../../src/types/tools';
import type { ToolCall } from '../../src/types/message';

vi.mock('../../src/permissions/engine', () => ({
  hasPermissionsToUseTool: vi.fn().mockResolvedValue({ behavior: 'allow' }),
}));

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

describe('Tool executor plugin hooks', () => {
  describe('preToolUse (input side)', () => {
    it('flows modified input through to the tool call', async () => {
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
      expect(callFn).toHaveBeenCalledWith(
        { command: 'plugin modified' },
        expect.objectContaining({ cwd: '/tmp' })
      );
    });

    it('blocks execution when preToolUse returns null', async () => {
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

    it('executes with the original input when preToolUse throws', async () => {
      const preHook = vi.fn().mockRejectedValue(new Error('hook exploded'));
      const callFn = vi.fn().mockResolvedValue({
        toolCallId: 'tc1',
        output: 'ok',
        isError: false,
      });
      const tool = makeTool({ call: callFn });
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        preToolUse: preHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.isError).toBe(false);
      expect(callFn).toHaveBeenCalledWith(
        { command: 'echo hello' },
        expect.anything()
      );
    });

    it('never invokes any per-tool prepare/finalize hooks even if present at runtime', async () => {
      // Guards the T01 removal: stray properties on a tool object must not
      // be probed or invoked by the executor.
      const prepareFn = vi.fn();
      const finalizeFn = vi.fn();
      const callFn = vi.fn().mockResolvedValue({
        toolCallId: 'tc1',
        output: 'ok',
        isError: false,
      });
      const tool = makeTool({ call: callFn }) as ToolDefinition & Record<string, unknown>;
      tool.prepare = prepareFn;
      tool.finalize = finalizeFn;
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.output).toBe('ok');
      expect(prepareFn).not.toHaveBeenCalled();
      expect(finalizeFn).not.toHaveBeenCalled();
    });
  });

  describe('postToolUse (result side)', () => {
    it('overrides the result when postToolUse returns non-null', async () => {
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

    it('keeps the original result when postToolUse returns null', async () => {
      const postHook = vi.fn().mockResolvedValue(null);
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        postToolUse: postHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.output).toBe('original output');
    });

    it('keeps the original result when postToolUse throws', async () => {
      const postHook = vi.fn().mockRejectedValue(new Error('postHook failed'));
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        postToolUse: postHook,
      });

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.isError).toBe(false);
      expect(result.output).toBe('original output');
    });
  });

  describe('pipeline ordering', () => {
    it('runs preToolUse → execute → postToolUse in order', async () => {
      const callOrder: string[] = [];
      const preHook = vi.fn().mockImplementation(async () => {
        callOrder.push('plugin-preToolUse');
        return { command: 'from plugin' };
      });
      const callFn = vi.fn().mockImplementation(async () => {
        callOrder.push('tool-call');
        return { toolCallId: 'tc1', output: 'ok', isError: false };
      });
      const postHook = vi.fn().mockImplementation(async (_name, _input, result) => {
        callOrder.push('plugin-postToolUse');
        return result;
      });

      const tool = makeTool({ call: callFn });
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        preToolUse: preHook,
        postToolUse: postHook,
      });

      await executor.executeSingle(makeToolCall(), makeContext());

      expect(callOrder).toEqual(['plugin-preToolUse', 'tool-call', 'plugin-postToolUse']);
    });

    it('propagates preToolUse-modified input into postToolUse', async () => {
      const seen: Array<Record<string, unknown>> = [];
      const postHook = vi.fn().mockImplementation(async (_name, input, result) => {
        seen.push(input as Record<string, unknown>);
        return result;
      });
      const tool = makeTool();
      const executor = new ToolExecutor([tool], '/tmp', undefined, {
        preToolUse: vi.fn().mockResolvedValue({ command: 'shared-input' }),
        postToolUse: postHook,
      });

      await executor.executeSingle(makeToolCall(), makeContext());

      expect(seen[0]).toEqual({ command: 'shared-input' });
    });
  });

  describe('backward compatibility (no hooks registered)', () => {
    it('executes tools normally without any hooks', async () => {
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

    it('returns an error for unknown tools', async () => {
      const executor = new ToolExecutor([], '/tmp');

      const result = await executor.executeSingle(
        makeToolCall({ toolName: 'Unknown' }),
        makeContext()
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain('Unknown tool');
    });

    it('surfaces tool call rejections as error results', async () => {
      const tool = makeTool({
        call: vi.fn().mockRejectedValue(new Error('execution failed')),
      });
      const executor = new ToolExecutor([tool], '/tmp');

      const result = await executor.executeSingle(makeToolCall(), makeContext());

      expect(result.isError).toBe(true);
      expect(result.output).toContain('execution failed');
    });

    it('works through executeParallel', async () => {
      const tool = makeTool({
        call: vi.fn().mockResolvedValue({
          toolCallId: 'tc',
          output: 'parallel ok',
          isError: false,
        }),
      });
      const executor = new ToolExecutor([tool], '/tmp');

      const results = await executor.executeParallel(
        [makeToolCall({ id: 'tc1' }), makeToolCall({ id: 'tc2' })],
        makeContext()
      );

      expect(results.size).toBe(2);
      const r1 = results.get('tc1') as ToolResult;
      const r2 = results.get('tc2') as ToolResult;
      expect(r1.output).toBe('parallel ok');
      expect(r2.output).toBe('parallel ok');
    });
  });
});
