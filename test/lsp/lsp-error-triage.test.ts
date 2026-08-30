// O6: LSP failures are triaged by kind, audit failures are recorded — round4 §4-O6

import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import { classifyLspError, LSPClientManager } from '../../src/lsp/client';
import { ToolExecutor } from '../../src/executors/toolExecutor';
import { spyOnLogger, type LoggerSpy } from '../helpers/logger-spy';
import type { ToolDefinition, ToolUseContext } from '../../src/tools/protocol';
import type { ToolCall } from '../../src/query/protocol';

// Environment probe for the soft-skip: the one-time ENOENT hint can only be
// exercised when the language server binary is genuinely absent. Skipped cases
// still show up in the reporter's skipped count (soft-skip ban compliant).
const TSLANG_SERVER_AVAILABLE =
  spawnSync('typescript-language-server', ['--version'], { stdio: 'ignore' }).status === 0;

describe('O6: classifyLspError', () => {
  it('buckets ENOENT, timeout, protocol and generic io failures', () => {
    const enoent = Object.assign(new Error('spawn typescript-language-server ENOENT'), { code: 'ENOENT' });
    expect(classifyLspError(enoent)).toBe('spawn-enoent');
    expect(classifyLspError(new Error('request timed out after 5000ms'))).toBe('timeout');
    expect(classifyLspError(new Error('invalid JSONRPC frame: parse error'))).toBe('protocol');
    expect(classifyLspError(new Error('EPIPE write after end'))).toBe('io');
  });
});

describe('O6: LSP connect triage', () => {
  let spy: LoggerSpy;

  afterEach(() => {
    spy?.stop();
  });

  it.skipIf(TSLANG_SERVER_AVAILABLE)(
    'warns once per language when the server binary is missing',
    async () => {
      spy = spyOnLogger('lsp', ['warn']);
      const manager = new LSPClientManager();

      const first = await manager.connect('typescript', 'file:///tmp');
      const second = await manager.connect('typescript', 'file:///tmp');

      expect(first).toBe(false);
      expect(second).toBe(false);
      const enoentLogs = spy.calls.filter((c) => c.data?.kind === 'spawn-enoent');
      expect(enoentLogs.length).toBe(1); // exactly one hint, not one per call
      expect(enoentLogs[0]!.text).toContain('typescript');
    },
    15000,
  );
});

// ── Audit write failures ─────────────────────────────────────────────────────

vi.mock('../../src/services/operation-audit-log', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/operation-audit-log')>();
  return {
    ...actual,
    getOperationAuditLog: () => {
      throw new Error('audit disk unavailable');
    },
  };
});

function makeBashTool(): ToolDefinition {
  return {
    name: 'Bash',
    description: 'test bash',
    inputSchema: {},
    call: vi.fn().mockResolvedValue({ toolCallId: 'tc1', output: 'ok', isError: false }),
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
  } as unknown as ToolUseContext;
}

describe('O6: audit write failures are recorded', () => {
  let spy: LoggerSpy;

  afterEach(() => {
    spy?.stop();
    vi.clearAllMocks();
  });

  it('logs a warn and increments the failure counter when the audit log throws', async () => {
    spy = spyOnLogger('audit', ['warn']);
    const executor = new ToolExecutor([makeBashTool()], '/tmp', undefined, undefined, {
      enabled: false,
      failIfNoSandbox: false,
    });

    const toolCall: ToolCall = { id: 'tc1', toolName: 'Bash', input: { command: 'echo hi' } };
    await executor.executeSingle(toolCall, makeContext());

    expect(executor.getAuditFailureCount()).toBe(1);
    // Two warns are expected here: (1) the one-time "session id unavailable"
    // fallback hint (state is absent in this harness) and (2) the audit write
    // failure itself.
    const failures = spy.calls.filter((c) => c.message === 'operation audit record failed');
    expect(failures.length).toBe(1);
    expect(failures[0]!.data).toMatchObject({
      toolName: 'Bash',
      failureCount: 1,
      reason: expect.stringContaining('audit disk unavailable'),
    });
    expect(spy.calls.some((c) => c.message.includes('session id unavailable'))).toBe(true);
  });
});
