// Behavior tests for the QueryEngine execution sub-module (QueryEngineExecution.ts).
//
// Scope (audit round3 T13 / H6): drive the REAL `executeToolCalls` orchestration
// over a REAL `ToolExecutor` (real permission engine, real sandbox decision
// layer in disabled mode, MockExecutionEnv) — neither the module under test nor
// any security-critical collaborator is mocked. Covered boundaries:
//   - tool_started/tool_completed/tool_failed emission and result pairing
//   - tool-result messages appended to the conversation with stable toolCallId
//   - concurrency-safe grouping (parallel vs sequential execution order)
//   - error surfacing: unknown tool, permission denial, non-interactive ask fail-safe
//   - hard-mode retry-discipline rejection (RuntimeControlHandler policy)
//   - repeated-failure context appended to error output text
//   - FileWrite/FileEdit tracking: modifiedFiles + progress + undo journal

import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { executeToolCalls } from '../../src/query/QueryEngineExecution';
import type { ExecutionDeps } from '../../src/query/QueryEngineExecution';
import { ConversationState } from '../../src/query/QueryEngineState';
import { RuntimeControlHandler } from '../../src/query/QueryEngineRuntimeControl';
import { ToolExecutor } from '../../src/executors/toolExecutor';
import { FileOperationJournal } from '../../src/state/file-operation-journal';
import type { ProgressTracker } from '../../src/query/QueryEngineTurnControl';
import { initializeState } from '../../src/bootstrap/state';
import { buildPermissionContext } from '../../src/permissions/engine';
import { createMockExecutionEnv } from '../../src/services/execution-env-mock';
import type { AgentEvent } from '../../src/state/types';
import type {
  AssistantMessage,
  ChatMessage,
  StreamEvent,
  ToolCall,
  ToolResult,
} from '../../src/query/protocol';
import type { PermissionResult } from '../../src/permissions/protocol';
import type { ToolDefinition, ToolUseContext } from '../../src/tools/protocol';

type EngineEvent = StreamEvent | AgentEvent;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-exec-test-'));
let turnCount = 0;

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  // isGitRepo:false keeps the FileWrite auto-stage path from spawning a real git.
  initializeState({ cwd: TMP_DIR, isGitRepo: false });
  turnCount = 4;
});

type CallFn = NonNullable<ToolDefinition['call']>;

function makeTool(
  name: string,
  call: CallFn,
  overrides: Partial<ToolDefinition> = {},
): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    inputSchema: z.any(),
    call,
    ...overrides,
  } as ToolDefinition;
}

function allow(): PermissionResult {
  return { behavior: 'allow', message: 'test allow' };
}

function toolCallOf(id: string, toolName: string, input: Record<string, unknown> = {}): ToolCall {
  return { id, toolName, input, status: 'pending' };
}

interface Harness {
  conversation: ConversationState;
  journal: FileOperationJournal;
  modifiedFiles: Set<string>;
  progress: ProgressTracker;
  runtimeControl: RuntimeControlHandler;
  run(toolCalls: ToolCall[]): Promise<EngineEvent[]>;
  runRaw(): Promise<EngineEvent[]>;
}

function makeHarness(tools: ToolDefinition[], runtimeControl?: RuntimeControlHandler): Harness {
  const conversation = new ConversationState();
  const executor = new ToolExecutor(
    tools,
    TMP_DIR,
    {}, // real permission engine; tools gate themselves via checkPermissions
    undefined,
    { enabled: false, backend: 'noop', failIfNoSandbox: false },
  );
  const journal = new FileOperationJournal();
  const modifiedFiles = new Set<string>();
  const progress: ProgressTracker = { lastModifiedTurn: 0, lastProgressTurn: 0 };
  const control = runtimeControl ?? new RuntimeControlHandler();

  const toolContext: ToolUseContext = {
    cwd: TMP_DIR,
    abortController: new AbortController(),
    permissions: buildPermissionContext(),
    env: createMockExecutionEnv(TMP_DIR),
    journal,
  };

  function makeDeps(): ExecutionDeps {
    return {
      conversation,
      toolExecutor: executor,
      runtimeControl: control,
      fileJournal: journal,
      modifiedFiles,
      progress,
      getTurnCount: () => turnCount,
      toolContext,
    };
  }

  async function runRaw(): Promise<EngineEvent[]> {
    const events: EngineEvent[] = [];
    for await (const ev of executeToolCalls(makeDeps())) events.push(ev);
    return events;
  }

  async function run(toolCalls: ToolCall[]): Promise<EngineEvent[]> {
    const assistantMsg: AssistantMessage = {
      id: `assistant_${toolCalls.map(tc => tc.id).join('-') || 'empty'}`,
      role: 'assistant',
      content: null,
      toolCalls,
      timestamp: Date.now(),
    };
    conversation.addMessage(assistantMsg);
    return runRaw();
  }

  return { conversation, journal, modifiedFiles, progress, runtimeControl: control, run, runRaw };
}

function types(events: EngineEvent[]): string[] {
  return events.map(e => e.type);
}

function toolMessages(conversation: ConversationState): ChatMessage[] {
  return conversation.getMessages().filter(m => m.role === 'tool');
}

async function drainGen(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ─── Results & event ordering ───────────────────────────────────────────────

describe('executeToolCalls — results and event ordering', () => {
  it('executes a single tool: started/completed events, result message appended with matching toolCallId', async () => {
    let observedEnvCwd = '';
    const harness = makeHarness([
      makeTool('Echo', async (_input, ctx) => {
        observedEnvCwd = ctx.cwd;
        return { output: 'echo-ok', isError: false } satisfies ToolResult;
      }, { checkPermissions: allow }),
    ]);

    const events = await harness.run([toolCallOf('tc1', 'Echo')]);

    expect(types(events)).toEqual(['agent:tool_started', 'agent:tool_completed']);
    const completed = events[1] as Extract<AgentEvent, { type: 'agent:tool_completed' }>;
    expect(completed.toolCall.id).toBe('tc1');
    expect(completed.result.output).toBe('echo-ok');

    // Real executor stack engaged (sandbox layer present but unsandboxed/disabled).
    expect((completed.result.metadata as Record<string, unknown>).sandboxed).toBe(false);
    expect(observedEnvCwd).toBe(TMP_DIR); // MockExecutionEnv reached the tool

    const msgs = toolMessages(harness.conversation);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('tool');
    expect(msgs[0].toolResults![0]).toMatchObject({
      toolCallId: 'tc1',
      output: 'echo-ok',
      isError: false,
    });
    expect(harness.conversation.getLastMessage()).toBe(msgs[0]);
  });

  it('emits all tool_started events up front, before any completion events', async () => {
    const harness = makeHarness([
      makeTool('Failing', async () => ({ output: 'boom', isError: true }), { checkPermissions: allow }),
      makeTool('Ok', async () => ({ output: 'fine', isError: false }), { checkPermissions: allow }),
    ]);

    const events = await harness.run([
      toolCallOf('tcf', 'Failing'),
      toolCallOf('tco', 'Ok'),
    ]);

    expect(types(events)).toEqual([
      'agent:tool_started',
      'agent:tool_started',
      'agent:tool_failed',
      'agent:tool_completed',
    ]);
    const failed = events[2] as Extract<AgentEvent, { type: 'agent:tool_failed' }>;
    expect(failed.toolCall.id).toBe('tcf');
    expect(failed.error.message).toContain('boom');
  });

  it('does nothing when the conversation has no assistant message to execute', async () => {
    const harness = makeHarness([
      makeTool('Echo', async () => ({ output: 'x', isError: false }), { checkPermissions: allow }),
    ]);

    // Empty conversation: no last message at all.
    await expect(harness.runRaw()).resolves.toEqual([]);

    // Last message is the user's — not an assistant tool-call turn.
    harness.conversation.addMessage({ id: 'u1', role: 'user', content: 'hi', timestamp: 1 } as ChatMessage);
    await expect(harness.runRaw()).resolves.toEqual([]);
    expect(toolMessages(harness.conversation)).toHaveLength(0);
  });

  it('does nothing for an assistant turn without tool calls', async () => {
    const harness = makeHarness([
      makeTool('Echo', async () => ({ output: 'x', isError: false }), { checkPermissions: allow }),
    ]);

    const events = await harness.run([]);
    expect(events).toEqual([]);
    expect(toolMessages(harness.conversation)).toHaveLength(0);
  });
});

// ─── Concurrency-safe grouping ──────────────────────────────────────────────

describe('executeToolCalls — concurrency-safe grouping via ToolExecutor', () => {
  it('runs concurrency-safe tools overlapped (both start before either finishes)', async () => {
    const log: string[] = [];
    const slow = (name: string) =>
      makeTool(name, async () => {
        log.push(`start:${name}`);
        await new Promise(resolve => setTimeout(resolve, 15));
        log.push(`end:${name}`);
        return { output: name, isError: false };
      }, { checkPermissions: allow });

    const harness = makeHarness([slow('SlowA'), slow('SlowB')]);

    const events = await harness.run([toolCallOf('a', 'SlowA'), toolCallOf('b', 'SlowB')]);

    expect(events.filter(e => e.type === 'agent:tool_completed')).toHaveLength(2);
    expect(log.indexOf('start:SlowB')).toBeLessThan(log.indexOf('end:SlowA'));
    expect(log.indexOf('start:SlowA')).toBeLessThan(log.indexOf('end:SlowB'));
  });

  it('serializes tools that declare isConcurrencySafe=false (strict start→end alternation)', async () => {
    const log: string[] = [];
    const solo = (name: string) =>
      makeTool(name, async () => {
        log.push(`start:${name}`);
        await new Promise(resolve => setTimeout(resolve, 5));
        log.push(`end:${name}`);
        return { output: name, isError: false };
      }, { checkPermissions: allow, isConcurrencySafe: () => false });

    const harness = makeHarness([solo('Solo1'), solo('Solo2')]);

    await harness.run([toolCallOf('s1', 'Solo1'), toolCallOf('s2', 'Solo2')]);

    expect(log).toEqual(['start:Solo1', 'end:Solo1', 'start:Solo2', 'end:Solo2']);
  });

  it('runs the concurrent group before the sequential group regardless of call order', async () => {
    const log: string[] = [];
    const solo = makeTool('Solo', async () => {
      log.push('run:Solo');
      return { output: 'solo', isError: false };
    }, { checkPermissions: allow, isConcurrencySafe: () => false });
    const fast = makeTool('Fast', async () => {
      log.push('run:Fast');
      return { output: 'fast', isError: false };
    }, { checkPermissions: allow });

    const harness = makeHarness([solo, fast]);

    // Sequential tool listed FIRST must still run after the concurrent group.
    const events = await harness.run([toolCallOf('seq', 'Solo'), toolCallOf('par', 'Fast')]);

    expect(log).toEqual(['run:Fast', 'run:Solo']);
    expect(types(events)).toEqual([
      'agent:tool_started',
      'agent:tool_started',
      'agent:tool_completed',
      'agent:tool_completed',
    ]);
    // Result messages follow the same grouping order as the completion events.
    const results = toolMessages(harness.conversation).flatMap(m => m.toolResults!);
    expect(results.map(r => r.output)).toEqual(['fast', 'solo']);
  });
});

// ─── Error surfacing through the real permission engine ─────────────────────

describe('executeToolCalls — errors surfaced', () => {
  it('reports unknown tools as failed results without invoking anything', async () => {
    const harness = makeHarness([]);

    const events = await harness.run([toolCallOf('u1', 'NoSuchTool')]);

    expect(types(events)).toEqual(['agent:tool_started', 'agent:tool_failed']);
    const failed = events[1] as Extract<AgentEvent, { type: 'agent:tool_failed' }>;
    expect(failed.error.message).toContain('Unknown tool: NoSuchTool');
    const msg = toolMessages(harness.conversation)[0];
    expect(msg.toolResults![0].isError).toBe(true);
    expect(msg.toolResults![0].output).toContain('Unknown tool: NoSuchTool');
  });

  it('surfaces a tool-level permission denial (real permission engine) as a failed result', async () => {
    const harness = makeHarness([
      makeTool('Guarded', async () => ({ output: 'should not run', isError: false }), {
        checkPermissions: () => ({ behavior: 'deny', message: 'nope' }) as PermissionResult,
      }),
    ]);

    const events = await harness.run([toolCallOf('g1', 'Guarded')]);

    expect(types(events)).toEqual(['agent:tool_started', 'agent:tool_failed']);
    const failed = events[1] as Extract<AgentEvent, { type: 'agent:tool_failed' }>;
    expect(failed.error.message).toContain('Permission denied');
    const result = toolMessages(harness.conversation)[0].toolResults![0];
    expect(result.isError).toBe(true);
    expect(result.output).toBe('Permission denied: nope');
  });

  it('applies the non-interactive ask fail-safe (deny) when no handler can answer an ask', async () => {
    const harness = makeHarness([
      // No checkPermissions → real engine falls through to mode default → 'ask'.
      makeTool('Asking', async () => ({ output: 'ran', isError: false })),
    ]);

    const events = await harness.run([toolCallOf('ask1', 'Asking')]);

    const failed = events[1] as Extract<AgentEvent, { type: 'agent:tool_failed' }>;
    expect(failed.error.message).toContain('non-interactive');
    expect(toolMessages(harness.conversation)[0].toolResults![0].isError).toBe(true);
  });
});

// ─── Runtime-control integration ────────────────────────────────────────────

describe('executeToolCalls — runtime control wiring', () => {
  it('hard-rejects a call whose identical predecessor already exhausted its failure budget', async () => {
    const flakyInput = { cmd: 'flaky' };
    const runtimeControl = new RuntimeControlHandler({
      enabled: true,
      retryIntervention: 'hard',
      maxSameCallRetries: 1,
    });
    // Pre-seed one recorded failure for this exact (tool, input) pair.
    runtimeControl.recordToolResult('Flaky', flakyInput, true);

    const callFn = vi.fn(async () => ({ output: 'flaky', isError: false }) as ToolResult);
    const harness = makeHarness([
      makeTool('Flaky', callFn, { checkPermissions: allow }),
    ], runtimeControl);

    const events = await harness.run([toolCallOf('f1', 'Flaky', flakyInput)]);

    expect(types(events)).toEqual(['agent:tool_started', 'agent:tool_failed']);
    expect(callFn).not.toHaveBeenCalled(); // rejected WITHOUT executing
    const failed = events[1] as Extract<AgentEvent, { type: 'agent:tool_failed' }>;
    expect(failed.error.message).toContain('Runtime control policy rejected this call');
    const result = toolMessages(harness.conversation)[0].toolResults![0];
    expect(result.isError).toBe(true);
  });

  it('appends the repeated-failure context to error output text (independent of the policy switch)', async () => {
    const failingInput = { n: 1 };
    const runtimeControl = new RuntimeControlHandler(); // policy disabled; context still active
    runtimeControl.recordToolResult('Flaky', failingInput, true);

    const harness = makeHarness([
      makeTool('Flaky', async () => ({ output: 'boom', isError: true }), { checkPermissions: allow }),
    ], runtimeControl);

    await harness.run([toolCallOf('x1', 'Flaky', failingInput)]);

    const content = toolMessages(harness.conversation)[0].content as string;
    expect(content).toContain('boom');
    expect(content).toContain('[Note: the previous identical Flaky call also failed');
    expect(content).toContain('1 consecutive failure(s)');
  });

  it('omits the repeated-failure note on first-time failures and resets after success', async () => {
    const runtimeControl = new RuntimeControlHandler();
    const input = { n: 2 };
    const harness = makeHarness([
      makeTool('Flaky', async () => ({ output: 'boom', isError: true }), { checkPermissions: allow }),
    ], runtimeControl);

    // First failure ever: no note.
    await harness.run([toolCallOf('y1', 'Flaky', input)]);
    expect(toolMessages(harness.conversation)[0].content).not.toContain('[Note:');

    // Success clears the consecutive-failure counter...
    const okHarnessInput = { n: 3 };
    const okHarness = makeHarness([
      makeTool('Flaky', async () => ({ output: 'ok', isError: false }), { checkPermissions: allow }),
    ], runtimeControl);
    await okHarness.run([toolCallOf('y2', 'Flaky', okHarnessInput)]);

    // ...so the next failure reports exactly 1 consecutive failure again.
    const failHarness = makeHarness([
      makeTool('Flaky', async () => ({ output: 'boom', isError: true }), { checkPermissions: allow }),
    ], runtimeControl);
    await failHarness.run([toolCallOf('y3', 'Flaky', { n: 4 })]);
    const content = toolMessages(failHarness.conversation)[0].content;
    expect(content).not.toContain('[Note:'); // different input hash than earlier failures
  });

  it('feeds turn composition into the exploration-loop breaker (read-only streak)', async () => {
    const runtimeControl = new RuntimeControlHandler({ enabled: true, maxReadOnlyStreak: 1 });
    const harness = makeHarness([
      makeTool('FileRead', async () => ({ output: 'file body', isError: false }), { checkPermissions: allow }),
    ], runtimeControl);

    await harness.run([toolCallOf('r1', 'FileRead')]);

    const injection = runtimeControl.drainPendingInjections();
    expect(injection).toContain('Exploration Loop Breaker');
    // Drained once → empty afterwards.
    expect(runtimeControl.drainPendingInjections()).toBe('');
  });
});

// ─── FileWrite/FileEdit tracking ────────────────────────────────────────────

describe('executeToolCalls — modification tracking and undo journal', () => {
  function writeTool(name: 'FileWrite' | 'FileEdit', metadata: Record<string, unknown>): ToolDefinition {
    return makeTool(name, async () => ({
      output: 'written',
      isError: false,
      metadata,
    }), { checkPermissions: allow });
  }

  it('tracks FileWrite results: modifiedFiles, progress marker and journal entry', async () => {
    const harness = makeHarness([
      writeTool('FileWrite', {
        path: '/tmp/x/a.txt',
        oldContent: 'old-body',
        newContent: 'new-body',
        backupPath: '/tmp/x/a.txt.bak',
      }),
    ]);

    await harness.run([toolCallOf('w1', 'FileWrite')]);

    expect(harness.modifiedFiles.has('/tmp/x/a.txt')).toBe(true);
    expect(harness.progress.lastModifiedTurn).toBe(turnCount);
    expect(harness.journal.size()).toBe(1);
    const entry = harness.journal.last()!;
    expect(entry).toMatchObject({
      filePath: '/tmp/x/a.txt',
      operation: 'write',
      oldContent: 'old-body',
      newContent: 'new-body',
      backupPath: '/tmp/x/a.txt.bak',
      turn: turnCount,
    });
  });

  it('records FileEdit results with operation "edit"', async () => {
    const harness = makeHarness([
      writeTool('FileEdit', { path: '/tmp/x/b.txt', oldContent: 'o', newContent: 'n' }),
    ]);

    await harness.run([toolCallOf('e1', 'FileEdit')]);

    expect(harness.journal.last()!.operation).toBe('edit');
    expect(harness.journal.last()!.filePath).toBe('/tmp/x/b.txt');
  });

  it('ignores non-write tools and write results without a resolvable path', async () => {
    const harness = makeHarness([
      writeTool('FileWrite', { oldContent: 'no path here' }),
      makeTool('Echo', async () => ({ output: 'plain', isError: false }), { checkPermissions: allow }),
    ]);

    await harness.run([toolCallOf('np1', 'FileWrite'), toolCallOf('np2', 'Echo')]);

    expect(harness.modifiedFiles.size).toBe(0);
    expect(harness.journal.size()).toBe(0);
  });
});
