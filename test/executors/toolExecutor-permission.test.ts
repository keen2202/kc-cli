/**
 * Tests for the interactive authorization hook in ToolExecutor (T1/T2).
 *
 * Covers:
 * - 'ask' decisions route to the registered UI handler
 * - 'deny' aborts execution with an error and never calls the tool
 * - 'allow' / 'allow_always' proceed to execution
 * - no handler registered preserves legacy (non-interactive) behavior
 * - FileWrite requests carry a diff preview; rejecting them blocks the write
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor } from '../../src/executors/toolExecutor';
import { hasPermissionsToUseTool } from '../../src/permissions/engine';
import type { ToolDefinition, ToolUseContext } from '../../src/types/tools';
import type { ToolCall } from '../../src/types/message';
import type { UIPermissionRequest } from '../../src/permissions/protocol';

vi.mock('../../src/permissions/engine', () => ({
  hasPermissionsToUseTool: vi.fn(),
}));

const mockedPerm = vi.mocked(hasPermissionsToUseTool);

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

// Construct with an explicit noop sandbox so the executor never fails to build
// on hosts without a real sandbox backend (e.g. Windows/CI without bubblewrap).
function makeExecutor(tools: ToolDefinition[]): ToolExecutor {
  return new ToolExecutor(tools, '/tmp', undefined, undefined, { backend: 'noop' });
}

describe('ToolExecutor — interactive authorization', () => {
  beforeEach(() => {
    // Every tool call requires confirmation for this suite.
    mockedPerm.mockResolvedValue({ behavior: 'ask', message: 'Confirm TestTool?' } as any);
  });

  it('routes an ask decision to the handler and proceeds on allow', async () => {
    const tool = makeTool();
    const executor = makeExecutor([tool]);
    const handler = vi.fn().mockResolvedValue('allow');
    executor.setPermissionRequestHandler(handler);

    const result = await executor.executeSingle(makeToolCall(), makeContext());

    expect(handler).toHaveBeenCalledTimes(1);
    const req = handler.mock.calls[0]![0] as UIPermissionRequest;
    expect(req.toolName).toBe('TestTool');
    expect(tool.call).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
  });

  it('aborts with an error and never calls the tool on deny', async () => {
    const tool = makeTool();
    const executor = makeExecutor([tool]);
    executor.setPermissionRequestHandler(vi.fn().mockResolvedValue('deny'));

    const result = await executor.executeSingle(makeToolCall(), makeContext());

    expect(tool.call).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Permission denied by user');
  });

  it('proceeds on allow_always and executes the tool', async () => {
    const tool = makeTool();
    const executor = makeExecutor([tool]);
    const handler = vi.fn().mockResolvedValue('allow_always');
    executor.setPermissionRequestHandler(handler);

    const result = await executor.executeSingle(makeToolCall(), makeContext());

    expect(handler).toHaveBeenCalledTimes(1);
    expect(tool.call).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
  });

  it('fail-safe denies an ask when no handler is registered (T1 default)', async () => {
    const tool = makeTool();
    const executor = makeExecutor([tool]);
    // No handler set — headless/non-interactive runs must NOT silently proceed.

    const result = await executor.executeSingle(makeToolCall(), makeContext());

    expect(tool.call).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Permission denied (non-interactive)');
  });

  it('proceeds on an ask with no handler when policy is proceed (opt-in)', async () => {
    const tool = makeTool();
    const executor = makeExecutor([tool]);
    executor.setNoninteractiveAskPolicy('proceed');

    const result = await executor.executeSingle(makeToolCall(), makeContext());

    expect(tool.call).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
  });

  it('proceeds on an ask with no handler when policy is allow (opt-in)', async () => {
    const tool = makeTool();
    const executor = makeExecutor([tool]);
    executor.setNoninteractiveAskPolicy('allow');

    const result = await executor.executeSingle(makeToolCall(), makeContext());

    expect(tool.call).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
  });

  it('attaches a diff preview for FileWrite and blocks the write on reject', async () => {
    const tool = makeTool({ name: 'FileWrite' });
    const executor = makeExecutor([tool]);
    let captured: UIPermissionRequest | undefined;
    executor.setPermissionRequestHandler(async (req) => {
      captured = req;
      return 'deny';
    });

    const result = await executor.executeSingle(
      makeToolCall({ toolName: 'FileWrite', input: { path: 'kc-diff-preview-nonexistent.txt', content: 'hello world' } }),
      makeContext(),
    );

    expect(captured?.diffs).toBeDefined();
    expect(captured!.diffs!).toHaveLength(1);
    expect(captured!.diffs![0]!.newContent).toBe('hello world');
    expect(captured!.diffs![0]!.oldContent).toBeNull();
    // Rejected → tool never runs, no file written.
    expect(tool.call).not.toHaveBeenCalled();
    expect(result.isError).toBe(true);
  });
});
