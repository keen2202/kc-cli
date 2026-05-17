import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor, SANDBOX_WRAPPED_MARKER } from '../../src/executors/toolExecutor';
import { initializeState } from '../../src/bootstrap/state';
import type { ToolDefinition, ToolUseContext } from '../../src/types/tools';
import type { ToolCall } from '../../src/types/message';
import { z } from 'zod';

function makeToolDef(name: string, callFn: (...args: any[]) => Promise<any>, timeoutSec?: number): ToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: z.object({}).passthrough(),
    call: callFn,
    timeout: timeoutSec,
  };
}

function makeContext(): ToolUseContext {
  return {
    cwd: '/tmp',
    abortController: new AbortController(),
    permissions: {
      mode: 'bypassPermissions' as any,
      cwd: '/tmp',
      toolName: '',
      input: {},
      alwaysDenyRules: [],
      alwaysAskRules: [],
      alwaysAllowRules: [],
      bypassPermissions: true,
    },
  };
}

describe('ToolExecutor timeout result fix', () => {
  beforeEach(() => {
    initializeState({ cwd: '/tmp', apiKey: 'test', permissionMode: 'bypassPermissions' as any });
  });
  it('should propagate toolCallId in timeout result', async () => {
    // Tool with a very short timeout (1 second) that never resolves
    const slowTool = makeToolDef('SlowTool', async () => {
      await new Promise(() => {}); // Never resolves
      return { output: 'done', isError: false };
    }, 1); // 1 second timeout

    const executor = new ToolExecutor([slowTool], '/tmp', undefined, undefined, { enabled: false });

    const toolCall: ToolCall = {
      id: 'test-call-id-123',
      toolName: 'SlowTool',
      input: {},
      status: 'pending',
    };

    const result = await executor.executeSingle(toolCall, makeContext());

    console.log('Timeout result:', JSON.stringify(result));

    // Should have the original toolCallId
    expect(result.toolCallId).toBe('test-call-id-123');
    expect(result.isError).toBe(true);
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain('timed out');
  }, 10000);

  it('should return successful result with toolCallId when tool completes within timeout', async () => {
    const fastTool = makeToolDef('FastTool', async () => {
      return { output: 'success', isError: false };
    }, 10); // 10 second timeout (plenty of time)

    const executor = new ToolExecutor([fastTool], '/tmp', undefined, undefined, { enabled: false });

    const toolCall: ToolCall = {
      id: 'fast-call-id',
      toolName: 'FastTool',
      input: {},
      status: 'pending',
    };

    const result = await executor.executeSingle(toolCall, makeContext());

    console.log('Fast result:', JSON.stringify(result));

    expect(result.toolCallId).toBe('fast-call-id');
    expect(result.isError).toBe(false);
    expect(result.output).toBe('success');
    expect(result.timedOut).toBeUndefined();
  });
});
