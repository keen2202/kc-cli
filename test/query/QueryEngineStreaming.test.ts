// Behavior tests for the QueryEngine streaming sub-module (QueryEngineStreaming.ts).
//
// Scope (audit round3 T13 / H6): drive the REAL stream consumer
// (`streamLLMTurn`) and the OpenAI pairing repair (`buildApiMessages`) with
// mocked LLM transports only (MockLLMClient / inline generators) — the module
// under test is never mocked. Covered boundaries:
//   - provider-event → agent-event mapping and ordering
//     (text/thinking deltas, tool_use collection, stop usage, turn_complete)
//   - graceful assistant-message assembly ([stream interrupted] fallback)
//   - abort mid-stream (partial turn kept, no throw)
//   - abort + underlying stream failure (cause-preserving wrap)
//   - global stream timeout enforcement (KC_STREAM_TIMEOUT_MS)
//   - tool_call/tool_result pairing repair (unanswered ids get placeholders)

import { describe, it, expect } from 'vitest';
import { streamLLMTurn, buildApiMessages } from '../../src/query/QueryEngineStreaming';
import type { StreamTurnDeps } from '../../src/query/QueryEngineStreaming';
import { ConversationState } from '../../src/query/QueryEngineState';
import { MockLLMClient } from '../utils/mock-llm';
import type { BaseApiClient, LLMRequestConfig, LLMStreamEvent } from '../../src/api/BaseApiClient';
import type { AssistantMessage, ChatMessage, StreamEvent, ToolCall } from '../../src/query/protocol';
import type { AgentEvent } from '../../src/state/types';

type EngineEvent = StreamEvent | AgentEvent;

const CFG: LLMRequestConfig = { model: 'mock-model', messages: [] };

function toolCall(id: string, toolName = 'Echo'): ToolCall {
  return { id, toolName, input: { x: 1 }, status: 'completed' };
}

/** Transport built from a raw event list (shapes MockLLMClient cannot express). */
function transportFromEvents(events: LLMStreamEvent[]): BaseApiClient {
  return {
    streamChat: async function* () {
      yield* events;
    },
  } as unknown as BaseApiClient;
}

/** Transport built from a lazily-created generator (for mid-stream scripting). */
function transportFromGenerator(
  make: () => AsyncGenerator<LLMStreamEvent>,
): BaseApiClient {
  return { streamChat: make } as unknown as BaseApiClient;
}

function makeDeps(client: BaseApiClient): {
  deps: StreamTurnDeps;
  conversation: ConversationState;
  state: { aborted: boolean; abortReasons: string[] };
} {
  const conversation = new ConversationState();
  const state = { aborted: false, abortReasons: [] as string[] };
  const deps: StreamTurnDeps = {
    apiClient: client,
    isAborted: () => state.aborted,
    abort: (reason?: string) => {
      state.aborted = true;
      state.abortReasons.push(reason ?? '');
    },
    addMessage: (m) => conversation.addMessage(m),
  };
  return { deps, conversation, state };
}

async function drain(gen: AsyncGenerator<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ─── streamLLMTurn: event sequence ──────────────────────────────────────────

describe('streamLLMTurn — event sequence', () => {
  it('maps text deltas in order, collects tool_use, and finishes with turn_complete carrying the reported usage', async () => {
    const client = new MockLLMClient();
    client.setResponses([
      {
        content: 'Hello streaming world',
        toolCalls: [toolCall('call_1')],
        usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      },
    ]);
    const { deps, conversation } = makeDeps(client as unknown as BaseApiClient);

    const events = await drain(streamLLMTurn(deps, CFG));

    // 'Hello streaming world' is 21 chars → 3 chunks of ≤10 chars, in order.
    expect(events.map(e => e.type)).toEqual([
      'agent:text_delta',
      'agent:text_delta',
      'agent:text_delta',
      'agent:turn_complete',
    ]);
    const text = events
      .filter((e): e is Extract<AgentEvent, { type: 'agent:text_delta' }> => e.type === 'agent:text_delta')
      .map(e => e.text)
      .join('');
    expect(text).toBe('Hello streaming world');

    // Completion event carries the provider-reported usage and the assembled message.
    const complete = events[events.length - 1] as Extract<AgentEvent, { type: 'agent:turn_complete' }>;
    expect(complete.usage).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });

    // The assistant message was appended exactly once and pairs with the event.
    expect(conversation.messageCount).toBe(1);
    const msg = conversation.getLastMessage() as AssistantMessage;
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello streaming world');
    expect(msg.toolCalls).toEqual([toolCall('call_1')]);
    expect(complete.message).toBe(msg);

    // tool_use events are consumed silently — they never surface as agent events.
    expect(events.some(e => e.type.startsWith('agent:tool_'))).toBe(false);
  });

  it('interleaves thinking deltas before/between text deltas without leaking them into the content', async () => {
    const client = transportFromEvents([
      { type: 'thinking_delta', thinking: 'plan-a' },
      { type: 'text_delta', text: 'A' },
      { type: 'thinking_delta', thinking: 'plan-b' },
      { type: 'text_delta', text: 'B' },
      { type: 'stop' },
    ]);
    const { deps, conversation } = makeDeps(client);

    const events = await drain(streamLLMTurn(deps, CFG));

    expect(events.map(e => e.type)).toEqual([
      'agent:thinking_delta',
      'agent:text_delta',
      'agent:thinking_delta',
      'agent:text_delta',
      'agent:turn_complete',
    ]);
    const thinking = events
      .filter((e): e is Extract<AgentEvent, { type: 'agent:thinking_delta' }> => e.type === 'agent:thinking_delta')
      .map(e => e.thinking);
    expect(thinking).toEqual(['plan-a', 'plan-b']);
    expect((conversation.getLastMessage() as AssistantMessage).content).toBe('AB');
  });

  it('computes totalTokens from input+output when the provider stop event omits it', async () => {
    const client = transportFromEvents([
      { type: 'text_delta', text: 'ok' },
      { type: 'stop', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 0 } },
    ]);
    const { deps } = makeDeps(client);

    const events = await drain(streamLLMTurn(deps, CFG));

    const complete = events[events.length - 1] as Extract<AgentEvent, { type: 'agent:turn_complete' }>;
    expect(complete.usage).toEqual({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });

  it('falls back to [stream interrupted] and still emits completion when the stream carried no content', async () => {
    const client = transportFromEvents([{ type: 'stop' }]);
    const { deps, conversation } = makeDeps(client);

    const events = await drain(streamLLMTurn(deps, CFG));

    expect(events.map(e => e.type)).toEqual(['agent:turn_complete']);
    const msg = conversation.getLastMessage() as AssistantMessage;
    expect(msg.content).toBe('[stream interrupted]');
    expect(msg.toolCalls).toBeUndefined();
    const complete = events[0] as Extract<AgentEvent, { type: 'agent:turn_complete' }>;
    expect(complete.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  it('passes the request config through to the transport untouched', async () => {
    const client = new MockLLMClient();
    client.setResponses([{ content: 'hi' }]);
    const { deps } = makeDeps(client as unknown as BaseApiClient);
    const cfg: LLMRequestConfig = {
      model: 'mock-model',
      messages: [{ id: 'u1', role: 'user', content: 'q', timestamp: 1 } as ChatMessage],
      systemPrompt: 'sys',
    };

    await drain(streamLLMTurn(deps, cfg));

    expect(client.getCallLog()).toHaveLength(1);
    expect(client.getCallLog()[0]).toBe(cfg);
  });
});

// ─── streamLLMTurn: abort handling ──────────────────────────────────────────

describe('streamLLMTurn — abort handling', () => {
  it('breaks mid-stream on abort, keeping only the partial content, and completes gracefully', async () => {
    const seen: string[] = [];
    const client = transportFromGenerator(async function* () {
      yield { type: 'text_delta', text: 'kept ' };
      seen.push('first-yielded');
      yield { type: 'text_delta', text: 'lost' };
      seen.push('second-yielded');
      yield { type: 'stop' };
    });
    const { deps, conversation, state } = makeDeps(client);

    const gen = streamLLMTurn(deps, CFG);
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'agent:text_delta', text: 'kept ' });

    // Simulate the user/engine aborting between provider events.
    state.aborted = true;

    const rest = await drain(gen);
    expect(seen).toEqual(['first-yielded']); // 'lost' was never pulled from the transport
    expect(rest.map(e => e.type)).toEqual(['agent:turn_complete']);
    expect((conversation.getLastMessage() as AssistantMessage).content).toBe('kept ');
  });

  it('produces an interrupted-but-complete turn when the query was already aborted before consuming', async () => {
    const client = transportFromEvents([
      { type: 'text_delta', text: 'never shown' },
      { type: 'stop' },
    ]);
    const { deps, conversation, state } = makeDeps(client);
    state.aborted = true;

    const events = await drain(streamLLMTurn(deps, CFG));

    expect(events.map(e => e.type)).toEqual(['agent:turn_complete']);
    expect((conversation.getLastMessage() as AssistantMessage).content).toBe('[stream interrupted]');
  });

  it('rethrows the original provider error untouched when the stream fails without an abort', async () => {
    const original = new Error('provider exploded');
    const client = new MockLLMClient();
    client.addErrorScenario('stream', original);
    const { deps, conversation } = makeDeps(client as unknown as BaseApiClient);

    await expect(drain(streamLLMTurn(deps, CFG))).rejects.toBe(original);
    // Failure path must not synthesize a partial assistant message.
    expect(conversation.messageCount).toBe(0);
  });

  it('wraps an underlying stream failure with the abort reason and preserves the cause', async () => {
    const client = transportFromGenerator(async function* () {
      yield { type: 'text_delta', text: 'a' };
      throw new Error('socket hang up');
    });
    const { deps, conversation, state } = makeDeps(client);

    const gen = streamLLMTurn(deps, CFG);
    await gen.next(); // consume first delta; abort lands before the failing pull
    state.aborted = true;

    const err = await gen.next().then(
      () => { throw new Error('expected streamLLMTurn to throw'); },
      (e: unknown) => e as Error,
    );
    expect(err.message).toContain('LLM stream aborted');
    expect(err.message).toContain('socket hang up');
    expect((err.cause as Error | undefined)?.message).toBe('socket hang up');
    expect(conversation.messageCount).toBe(0);
  });

  it('enforces the global stream timeout by calling abort("LLM stream timeout")', async () => {
    const prevTimeoutEnv = process.env.KC_STREAM_TIMEOUT_MS;
    process.env.KC_STREAM_TIMEOUT_MS = '40';
    let release: (() => void) | undefined;
    const hung = new Promise<void>(resolve => { release = resolve; });
    try {
      const client = transportFromGenerator(async function* () {
        yield { type: 'text_delta', text: 'start' };
        await hung;
        yield { type: 'text_delta', text: 'never' };
      });
      // Deps whose abort unblocks the hanging transport — mirroring how a real
      // provider stream rejects once its abort signal fires.
      const conversation = new ConversationState();
      const state = { aborted: false, abortReasons: [] as string[] };
      const deps: StreamTurnDeps = {
        apiClient: client,
        isAborted: () => state.aborted,
        abort: (reason?: string) => {
          state.aborted = true;
          state.abortReasons.push(reason ?? '');
          release?.();
        },
        addMessage: (m) => conversation.addMessage(m),
      };

      const events = await drain(streamLLMTurn(deps, CFG));

      expect(state.abortReasons).toEqual(['LLM stream timeout']);
      expect(events.map(e => e.type)).toEqual(['agent:text_delta', 'agent:turn_complete']);
      expect((conversation.getLastMessage() as AssistantMessage).content).toBe('start');
    } finally {
      if (prevTimeoutEnv === undefined) delete process.env.KC_STREAM_TIMEOUT_MS;
      else process.env.KC_STREAM_TIMEOUT_MS = prevTimeoutEnv;
      release?.();
    }
  });
});

// ─── buildApiMessages: pairing repair ───────────────────────────────────────

describe('buildApiMessages — tool_call pairing repair', () => {
  function assistant(id: string, calls: ToolCall[]): ChatMessage {
    return { id, role: 'assistant', content: null, toolCalls: calls, timestamp: 1 } as ChatMessage;
  }
  function toolMsg(id: string, answeredIds: string[]): ChatMessage {
    return {
      id,
      role: 'tool',
      content: 'result',
      toolResults: answeredIds.map(toolCallId => ({ toolCallId, output: 'ok', isError: false })),
      timestamp: 2,
    } as ChatMessage;
  }

  it('hoists the system message to the front and preserves the order of the rest', () => {
    const system = { id: 's', role: 'system', content: 'sys', timestamp: 0 } as ChatMessage;
    const user = { id: 'u', role: 'user', content: 'q', timestamp: 1 } as ChatMessage;
    const assistantPlain = { id: 'a', role: 'assistant', content: 'hi', timestamp: 2 } as ChatMessage;

    const out = buildApiMessages([user, system, assistantPlain]);

    expect(out.map(m => m.role)).toEqual(['system', 'user', 'assistant']);
    expect(out[0]).toBe(system);
  });

  it('synthesizes an error placeholder for an unanswered assistant tool_call', () => {
    const tc = toolCall('call_1');
    const out = buildApiMessages([assistant('a1', [tc])]);

    expect(out).toHaveLength(2);
    const placeholder = out[1];
    expect(placeholder.role).toBe('tool');
    expect(placeholder.toolResults).toHaveLength(1);
    expect(placeholder.toolResults![0].toolCallId).toBe('call_1');
    expect(placeholder.toolResults![0].isError).toBe(true);
    expect(placeholder.content).toContain('did not produce a result');
  });

  it('leaves correctly paired tool messages untouched (no duplicate placeholders)', () => {
    const out = buildApiMessages([
      assistant('a1', [toolCall('call_1')]),
      toolMsg('t1', ['call_1']),
    ]);

    expect(out).toHaveLength(2);
    expect(out[1].role).toBe('tool');
    expect(out[1].toolResults![0].toolCallId).toBe('call_1');
  });

  it('fills only the gap when an assistant turn answers some of its tool_calls', () => {
    const out = buildApiMessages([
      assistant('a1', [toolCall('call_1'), toolCall('call_2')]),
      toolMsg('t1', ['call_1']),
    ]);

    const toolMessages = out.filter(m => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    const answered = toolMessages.flatMap(m => m.toolResults!.map(tr => tr.toolCallId));
    expect(answered.sort()).toEqual(['call_1', 'call_2']);
    const placeholder = toolMessages.find(m => m.toolResults![0].toolCallId === 'call_2');
    expect(placeholder!.toolResults![0].isError).toBe(true);
  });

  it('repairs each assistant turn independently across multi-turn history', () => {
    const out = buildApiMessages([
      assistant('a1', [toolCall('call_1')]),
      toolMsg('t1', ['call_1']),
      assistant('a2', [toolCall('call_2')]),
    ]);

    expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'assistant', 'tool']);
    expect(out[3].toolResults![0].toolCallId).toBe('call_2');
  });

  it('returns conversations without tool calls unchanged', () => {
    const user = { id: 'u', role: 'user', content: 'q', timestamp: 1 } as ChatMessage;
    const assistantPlain = { id: 'a', role: 'assistant', content: 'hi', timestamp: 2 } as ChatMessage;

    expect(buildApiMessages([])).toEqual([]);
    expect(buildApiMessages([user, assistantPlain])).toEqual([user, assistantPlain]);
  });
});
