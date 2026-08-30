// Unknown-tool fail-closed behaviour in parallel batches — round4 §3-R5
//
// The grouping check was `tool?.isConcurrencySafe?.(input) !== false`. For an
// unknown tool the optional chain short-circuits to `undefined`, which is
// `!== false`, so the unknown tool was routed into the concurrent batch and
// only discovered later inside executeSingle.

import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor } from '../../src/executors/toolExecutor';
import type { ToolDefinition, ToolUseContext } from '../../src/types/tools';
import type { ToolCall } from '../../src/types/message';

vi.mock('../../src/permissions/engine', () => ({
  hasPermissionsToUseTool: vi.fn().mockResolvedValue({ behavior: 'allow' }),
}));

function makeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'TestTool',
    description: 'A test tool',
    inputSchema: {},
    call: vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: 'ok', isError: false }),
    isConcurrencySafe: () => true,
    ...overrides,
  };
}

function makeToolCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return { id: 'tc1', toolName: 'TestTool', input: {}, ...overrides };
}

/**
 * This environment has no bubblewrap/seccomp/docker, and the executor hard-fails
 * when no backend is available. Noop backend keeps the tests about tool
 * dispatch rather than about sandbox availability.
 */
function newExecutor(tools: ToolDefinition[]): ToolExecutor {
  return new ToolExecutor(tools, '/tmp', undefined, undefined, {
    backend: 'noop',
    failIfNoSandbox: false,
  });
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

describe('executeParallel with an unknown tool', () => {
  it('returns an is_error result naming the tool, without throwing', async () => {
    const known = makeTool();
    const executor = newExecutor([known]);

    const results = await executor.executeParallel(
      [makeToolCall({ id: 'missing', toolName: 'NoSuchTool' })],
      makeContext(),
    );

    const result = results.get('missing') as { output: string; isError: boolean };
    expect(result).toBeDefined();
    expect(result.isError).toBe(true);
    expect(result.output).toContain('NoSuchTool');
  });

  it('does not hand the unknown tool to executeSingle', async () => {
    const executor = newExecutor([makeTool()]);
    const spy = vi.spyOn(executor, 'executeSingle');

    await executor.executeParallel(
      [makeToolCall({ id: 'missing', toolName: 'NoSuchTool' })],
      makeContext(),
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('still runs the known tools in the same batch', async () => {
    const known = makeTool();
    const executor = newExecutor([known]);

    const results = await executor.executeParallel(
      [
        makeToolCall({ id: 'missing', toolName: 'NoSuchTool' }),
        makeToolCall({ id: 'known', toolName: 'TestTool' }),
      ],
      makeContext(),
    );

    expect((results.get('missing') as { isError: boolean }).isError).toBe(true);
    expect((results.get('known') as { output: string }).output).toBe('ok');
    expect(known.call).toHaveBeenCalledTimes(1);
  });

  it('notifies onSettled for the rejected call so callers do not wait on it', async () => {
    const executor = newExecutor([makeTool()]);
    const settled: string[] = [];

    await executor.executeParallel(
      [makeToolCall({ id: 'missing', toolName: 'NoSuchTool' })],
      makeContext(),
      (id) => settled.push(id),
    );

    expect(settled).toEqual(['missing']);
  });

  it('keeps routing a known non-concurrency-safe tool to the sequential group', async () => {
    // Semantic check: this grouping decision must not change.
    const unsafe = makeTool({ name: 'Unsafe', isConcurrencySafe: () => false });
    const executor = newExecutor([unsafe]);
    const spy = vi.spyOn(executor, 'executeSingle');

    await executor.executeParallel(
      [makeToolCall({ id: 'u', toolName: 'Unsafe' })],
      makeContext(),
    );

    // Sequential tools still go through executeSingle.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(unsafe.call).toHaveBeenCalledTimes(1);
  });
});
