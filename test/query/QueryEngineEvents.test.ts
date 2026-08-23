// Behavior tests for the QueryEngine events sub-module (QueryEngineEvents.ts).
//
// Scope (audit round3 T13 / H6): drive the REAL event factories and pin the
// emission/ordering guarantees of the engine state machine transitions that
// consume them. Covered boundaries:
//   - each factory emits the correctly-typed AgentEvent payload for its
//     transition (text/thinking delta, tool started/completed/failed,
//     turn_complete incl. default zero usage)
//   - cross-module ordering guarantees: streaming deltas always precede
//     turn_complete; every tool_started precedes any terminal tool result;
//     per-result mapping of completed vs failed
//   - agent:steered event shape (steered flag) and its absence when nothing
//     was steered

import { describe, it, expect } from 'vitest';
import {
  textDeltaEvent,
  thinkingDeltaEvent,
  turnCompleteEvent,
  toolStartedEvent,
  toolCompletedEvent,
  toolFailedEvent,
} from '../../src/query/QueryEngineEvents';
import { streamLLMTurn } from '../../src/query/QueryEngineStreaming';
import type { StreamTurnDeps } from '../../src/query/QueryEngineStreaming';
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
import { MockLLMClient } from '../utils/mock-llm';
import type { BaseApiClient, LLMRequestConfig } from '../../src/api/BaseApiClient';
import type { AssistantMessage, ChatMessage, StreamEvent, ToolCall, ToolResult } from '../../src/query/protocol';
import type { AgentEvent } from '../../src/state/types';
import type { ToolDefinition, ToolUseContext } from '../../src/tools/protocol';

type EngineEvent = StreamEvent | AgentEvent;

const TMP = '/tmp/kc-events-test';

// ─── Event factories: per-transition payloads ───────────────────────────────

describe('QueryEngineEvents — factories', () => {
  it('textDeltaEvent carries the streamed text fragment', () => {
    const ev = textDeltaEvent('hello ');
    expect(ev.type).toBe('agent:text_delta');
    expect((ev as { text: string }).text).toBe('hello ');
    expect(typeof ev.timestamp).toBe('number');
  });

  it('thinkingDeltaEvent carries the thinking fragment', () => {
    const ev = thinkingDeltaEvent('reasoning…');
    expect(ev.type).toBe('agent:thinking_delta');
    expect((ev as { thinking: string }).thinking).toBe('reasoning…');
    expect(typeof ev.timestamp).toBe('number');
  });

  it('turnCompleteEvent forwards provider usage verbatim', () => {
    const message: AssistantMessage = {
      id: 'a1', role: 'assistant', content: 'done', timestamp: 1,
    };
    const usage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };
    const ev = turnCompleteEvent(message, usage);

    expect(ev.type).toBe('agent:turn_complete');
    if (ev.type === 'agent:turn_complete') {
      expect(ev.message).toBe(message);
      expect(ev.usage).toEqual(usage);
    }
  });

  it('turnCompleteEvent defaults to zeroed usage when none was reported', () => {
    const message: AssistantMessage = {
      id: 'a2', role: 'assistant', content: null, timestamp: 1,
    };
    const ev = turnCompleteEvent(message);
    expect(ev.type).toBe('agent:turn_complete');
    if (ev.type === 'agent:turn_complete') {
      expect(ev.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      expect(ev.message.content).toBeNull();
    }
  });

  it('toolStartedEvent wraps the originating ToolCall identity', () => {
    const tc: ToolCall = { id: 'tc9', toolName: 'Echo', input: {}, status: 'pending' };
    const ev = toolStartedEvent(tc);
    expect(ev.type).toBe('agent:tool_started');
    if (ev.type === 'agent:tool_started') {
      expect(ev.toolCall).toBe(tc);
    }
  });

  it('toolCompletedEvent pairs the call with its successful result', () => {
    const tc: ToolCall = { id: 'tc1', toolName: 'Echo', input: {}, status: 'completed' };
    const result: ToolResult = { toolCallId: 'tc1', output: 'ok', isError: false };
    const ev = toolCompletedEvent(tc, result);
    expect(ev.type).toBe('agent:tool_completed');
    if (ev.type === 'agent:tool_completed') {
      expect(ev.toolCall).toBe(tc);
      expect(ev.result).toBe(result);
      expect(ev.result.isError).toBe(false);
    }
  });

  it('toolFailedEvent attaches the failure Error to the call', () => {
    const tc: ToolCall = { id: 'tc2', toolName: 'Boom', input: {}, status: 'failed' };
    const err = new Error('exploded');
    const ev = toolFailedEvent(tc, err);
    expect(ev.type).toBe('agent:tool_failed');
    if (ev.type === 'agent:tool_failed') {
      expect(ev.toolCall.id).toBe('tc2');
      expect(ev.error).toBe(err);
    }
  });
});

// ─── Cross-transition ordering guarantees ───────────────────────────────────

function makeStreamDeps(client: BaseApiClient): {
  deps: StreamTurnDeps;
  conversation: ConversationState;
} {
  const conversation = new ConversationState();
  return {
    conversation,
    deps: {
      apiClient: client,
      isAborted: () => false,
      abort: () => {},
      addMessage: (m) => conversation.addMessage(m),
    },
  };
}

async function drain(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

function makeExecutor(tools: ToolDefinition[], cwd: string): ToolExecutor {
  // Sandbox layer disabled deterministically: no backend probing, everything
  // runs unsandboxed — but it is the real decision layer, not a stub.
  return new ToolExecutor(tools, cwd, {}, undefined, {
    enabled: false, backend: 'noop', failIfNoSandbox: false,
  });
}

function executionDeps(
  conversation: ConversationState,
  executor: ToolExecutor,
  cwd: string,
): ExecutionDeps {
  const journal = new FileOperationJournal();
  return {
    conversation,
    toolExecutor: executor,
    runtimeControl: new RuntimeControlHandler(),
    fileJournal: journal,
    modifiedFiles: new Set<string>(),
    progress: { lastModifiedTurn: 0, lastProgressTurn: 0 } satisfies ProgressTracker,
    getTurnCount: () => 1,
    toolContext: {
      cwd,
      abortController: new AbortController(),
      permissions: buildPermissionContext(),
      env: createMockExecutionEnv(cwd),
      journal,
    } satisfies ToolUseContext,
  };
}

describe('QueryEngineEvents — state machine ordering guarantees', () => {
  it('streaming transition: every text_delta precedes turn_complete', async () => {
    initializeState({ cwd: TMP, isGitRepo: false });
    const client = new MockLLMClient();
    client.setResponses([{ content: 'abc def ghi jkl' }]);
    const { deps } = makeStreamDeps(client as unknown as BaseApiClient);

    const events = await drain(streamLLMTurn(deps, { model: 'mock-model', messages: [] }));

    const completeIdx = events.findIndex(e => e.type === 'agent:turn_complete');
    expect(completeIdx).toBeGreaterThan(0);
    expect(events.slice(0, completeIdx).every(e => e.type === 'agent:text_delta')).toBe(true);
    expect(events.slice(completeIdx + 1)).toHaveLength(0); // completion terminates the stream
  });

  it('executing transition: all tool_started events fire before any terminal tool result', async () => {
    initializeState({ cwd: TMP, isGitRepo: false });
    const tools: ToolDefinition[] = [
      {
        name: 'Failing',
        description: 'always fails',
        inputSchema: {} as ToolDefinition['inputSchema'],
        checkPermissions: () => ({ behavior: 'allow' }),
        call: async () => ({ output: 'boom', isError: true }),
      },
      {
        name: 'Ok',
        description: 'always succeeds',
        inputSchema: {} as ToolDefinition['inputSchema'],
        checkPermissions: () => ({ behavior: 'allow' }),
        call: async () => ({ output: 'fine', isError: false }),
      },
    ] as ToolDefinition[];

    const conversation = new ConversationState();
    conversation.addMessage({
      id: 'a1',
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'f1', toolName: 'Failing', input: {}, status: 'pending' },
        { id: 'o1', toolName: 'Ok', input: {}, status: 'pending' },
      ],
      timestamp: Date.now(),
    } as ChatMessage);

    const events = await drain(executeToolCalls(executionDeps(conversation, makeExecutor(tools, TMP), TMP)));

    expect(events.map(e => e.type)).toEqual([
      'agent:tool_started',
      'agent:tool_started',
      'agent:tool_failed',
      'agent:tool_completed',
    ]);
    // Per-result mapping holds: failing call → failed, succeeding call → completed.
    const failed = events[2] as Extract<AgentEvent, { type: 'agent:tool_failed' }>;
    const completed = events[3] as Extract<AgentEvent, { type: 'agent:tool_completed' }>;
    expect(failed.toolCall.toolName).toBe('Failing');
    expect(completed.toolCall.toolName).toBe('Ok');
  });

  it('full streaming→executing cycle emits the canonical ordered event sequence', async () => {
    initializeState({ cwd: TMP, isGitRepo: false });
    const tools: ToolDefinition[] = [
      {
        name: 'Echo',
        description: 'echoes',
        inputSchema: {} as ToolDefinition['inputSchema'],
        checkPermissions: () => ({ behavior: 'allow' }),
        call: async () => ({ output: 'echo!', isError: false }),
      },
    ] as ToolDefinition[];

    // Phase 1 — streaming transition over a mocked LLM transport.
    const client = new MockLLMClient();
    client.setResponses([{ content: 'hi' }]);
    const { deps, conversation } = makeStreamDeps(client as unknown as BaseApiClient);
    const streamingEvents = await drain(streamLLMTurn(deps, { model: 'mock-model', messages: [] }));

    // Phase 2 — executing transition over the assistant tool-call turn.
    conversation.addMessage({
      id: 'a-tool-turn',
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'e1', toolName: 'Echo', input: {}, status: 'pending' }],
      timestamp: Date.now(),
    } as ChatMessage);
    const executingEvents = await drain(
      executeToolCalls(executionDeps(conversation, makeExecutor(tools, TMP), TMP)),
    );

    const sequence = [...streamingEvents, ...executingEvents].map(e => e.type);
    expect(sequence).toEqual([
      'agent:text_delta',
      'agent:turn_complete',
      'agent:tool_started',
      'agent:tool_completed',
    ]);
  });
});

// ─── Steered flag ───────────────────────────────────────────────────────────

describe('QueryEngineEvents — steered flag', () => {
  it('the agent:steered event shape carries the injected user message', () => {
    const steered: AgentEvent = {
      type: 'agent:steered',
      message: { id: 'm1', role: 'user', content: 'redirect now', timestamp: Date.now() } as ChatMessage,
      timestamp: Date.now(),
    };
    expect(steered.type).toBe('agent:steered');
    if (steered.type === 'agent:steered') {
      expect(steered.message.role).toBe('user');
      expect(steered.message.content).toBe('redirect now');
      expect(typeof steered.timestamp).toBe('number');
    }
  });

  it('an unsteered streaming→executing cycle emits no steered events', async () => {
    initializeState({ cwd: TMP, isGitRepo: false });
    const tools: ToolDefinition[] = [
      {
        name: 'Echo',
        description: 'echoes',
        inputSchema: {} as ToolDefinition['inputSchema'],
        checkPermissions: () => ({ behavior: 'allow' }),
        call: async () => ({ output: 'echo!', isError: false }),
      },
    ] as ToolDefinition[];

    const client = new MockLLMClient();
    client.setResponses([{ content: 'plain answer' }]);
    const { deps, conversation } = makeStreamDeps(client as unknown as BaseApiClient);
    const events = await drain(streamLLMTurn(deps, { model: 'mock-model', messages: [] }));
    conversation.addMessage({
      id: 'a-plain',
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'p1', toolName: 'Echo', input: {}, status: 'pending' }],
      timestamp: Date.now(),
    } as ChatMessage);
    events.push(...await drain(executeToolCalls(executionDeps(conversation, makeExecutor(tools, TMP), TMP))));

    expect(events.some(e => e.type === 'agent:steered')).toBe(false);
  });
});
