// T23 (P2): tools registered after executor construction (background MCP) must
// be executable and visible — without weakening the R5 unknown-tool fail-closed.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutor, type DynamicToolSource } from '../../src/executors/toolExecutor';
import type { ToolDefinition, ToolUseContext } from '../../src/tools/protocol';
import type { ToolCall } from '../../src/query/protocol';
import { initializeState } from '../../src/bootstrap/state';

beforeEach(() => {
  // The permission engine reads global state on the execution path.
  initializeState({
    cwd: '/tmp',
    projectRoot: null,
    sessionId: 't23',
    permissionMode: 'default',
    verbose: false,
    printMode: false,
    bareMode: false,
    maxTurns: null,
    maxBudgetUsd: null,
    config: null,
  });
});

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
  } as unknown as ToolUseContext;
}

function staticTool(): ToolDefinition {
  return {
    name: 'Bash',
    description: 'static tool',
    inputSchema: {},
    call: vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: 'static-ok', isError: false }),
  };
}

function lateMcpTool(): ToolDefinition {
  return {
    name: 'mcp__fs__read',
    description: 'registered after startup by a background MCP connect',
    inputSchema: { type: 'object' },
    call: vi.fn().mockResolvedValue({ toolCallId: 'tc2', output: 'mcp-ok', isError: false }),
  };
}

function makeExecutorWithHangingRegistration(): {
  executor: ToolExecutor;
  source: { registry: Map<string, ToolDefinition>; lateTool: ToolDefinition };
} {
  // Simulates the shared registry state: the MCP tool lands in the registry
  // AFTER the executor was constructed (background connect resolved later).
  const registry = new Map<string, ToolDefinition>();
  const lateTool = lateMcpTool();
  const source: DynamicToolSource & { registry: Map<string, ToolDefinition>; lateTool: ToolDefinition } = {
    registry,
    lateTool,
    getTool: (name) => registry.get(name),
    getToolNames: () => Array.from(registry.keys()),
  };
  const executor = new ToolExecutor([staticTool()], '/tmp',
    // The user would allow-list the MCP server's tools in settings.
    { alwaysAllowRules: ['mcp__fs__read'] },
    undefined, {
      enabled: false,
      failIfNoSandbox: false,
    }, undefined, source);
  return { executor, source };
}

describe('T23: dynamic tool source (background MCP registration)', () => {
  it('executes a tool that was registered after construction', async () => {
    const { executor, source } = makeExecutorWithHangingRegistration();

    // Before the background connect lands: unknown → fail closed.
    const early = await executor.executeSingle(
      { id: 'tc2', toolName: 'mcp__fs__read', input: {} } as ToolCall,
      makeContext(),
    );
    expect(early.isError).toBe(true);
    expect(early.output).toContain('Unknown tool');

    // The background MCP connect completes and registers the tool.
    source.registry.set('mcp__fs__read', source.lateTool);

    const result = await executor.executeSingle(
      { id: 'tc2', toolName: 'mcp__fs__read', input: {} } as ToolCall,
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.output).toBe('mcp-ok');
  });

  it('exposes late tools to per-request tool definition assembly', () => {
    const { executor, source } = makeExecutorWithHangingRegistration();

    expect(executor.getRegisteredTools()).toEqual(['Bash']);
    source.registry.set('mcp__fs__read', source.lateTool);

    const names = executor.getRegisteredTools();
    expect(names).toContain('mcp__fs__read');
    expect(executor.getTool('mcp__fs__read')).toBe(source.lateTool);
    expect(executor.hasTool('mcp__fs__read')).toBe(true);
    // Static ordering is preserved for prompt-cache stability.
    expect(names.indexOf('Bash')).toBeLessThan(names.indexOf('mcp__fs__read'));
  });

  it('still fails closed for genuinely unknown tools (R5 intact)', async () => {
    const { executor, source } = makeExecutorWithHangingRegistration();
    source.registry.set('mcp__fs__read', source.lateTool);

    const result = await executor.executeSingle(
      { id: 'tc3', toolName: 'totally_fake_tool', input: {} } as ToolCall,
      makeContext(),
    );
    expect(result.isError).toBe(true);
    expect(result.output).toContain('totally_fake_tool');
  });
});
