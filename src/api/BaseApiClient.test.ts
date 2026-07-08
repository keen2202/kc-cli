// Tests for BaseApiClient format caching (P7)

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { BaseApiClient } from './BaseApiClient';
import type { ChatMessage, ToolCall } from '../query/protocol';
import type { ToolDefinition } from '../tools/protocol';

// ── Helper: concrete subclass for testing ─────────────────────────────────

class TestClient extends BaseApiClient {
  constructor() {
    super({ apiKey: 'test-key', baseUrl: 'http://localhost:9999', model: 'test-model' });
  }

  chat(): Promise<never> {
    throw new Error('Not implemented in test');
  }

  async *streamChat(): AsyncGenerator<never> {
    // no-op
  }

  validateApiKey(): boolean {
    return true;
  }

  getModelInfo() {
    return { provider: 'test', model: 'test', maxTokens: 4096, supportsStreaming: true, supportsTools: true };
  }

  // Expose protected methods for testing
  public callFormatMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return this.formatMessages(messages);
  }

  public callFormatTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    return this.formatTools(tools);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────

const schemaA = z.object({ query: z.string() });
const schemaB = z.object({ path: z.string() });

const bashTool: ToolDefinition = {
  name: 'Bash',
  description: 'Execute bash commands',
  inputSchema: z.object({ command: z.string(), timeout: z.number().optional() }),
  call: async () => ({ output: '', isError: false }),
};

const readTool: ToolDefinition = {
  name: 'FileRead',
  description: 'Read a file',
  inputSchema: z.object({ path: z.string() }),
  call: async () => ({ output: '', isError: false }),
};

const writeTool: ToolDefinition = {
  name: 'FileWrite',
  description: 'Write a file',
  inputSchema: schemaA,
  call: async () => ({ output: '', isError: false }),
};

function makeMsg(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage['role']; content: string | null }): ChatMessage {
  return {
    timestamp: Date.now(),
    ...overrides,
  } as ChatMessage;
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('BaseApiClient formatMessages cache [P7]', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new TestClient();
  });

  it('should return the same reference when called twice with the same messages', () => {
    const msgs: ChatMessage[] = [
      makeMsg({ id: 'msg-1', role: 'user', content: 'Hello' }),
      makeMsg({ id: 'msg-2', role: 'assistant', content: 'Hi there' }),
    ];

    const first = client.callFormatMessages(msgs);
    const second = client.callFormatMessages(msgs);

    expect(second).toBe(first);
  });

  it('should return the same reference when called twice with appended messages (prefix cached)', () => {
    const msgs1: ChatMessage[] = [
      makeMsg({ id: 'msg-1', role: 'user', content: 'First' }),
    ];
    const msgs2: ChatMessage[] = [
      makeMsg({ id: 'msg-1', role: 'user', content: 'First' }),
      makeMsg({ id: 'msg-2', role: 'assistant', content: 'Second' }),
    ];

    const first = client.callFormatMessages(msgs1);
    const second = client.callFormatMessages(msgs2);

    // The first message should be cached and shared between the two arrays
    expect(second[0]).toBe(first[0]);
  });

  it('should still format correct content (cache not corrupt)', () => {
    const msgs: ChatMessage[] = [
      makeMsg({ id: 'm1', role: 'user', content: 'hello world' }),
      makeMsg({ id: 'm2', role: 'assistant', content: 'goodbye' }),
    ];

    const result = client.callFormatMessages(msgs);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'user', content: 'hello world' });
    expect(result[1]).toEqual({ role: 'assistant', content: 'goodbye' });
  });

  it('should handle tool messages with tool_call_id', () => {
    const msgs: ChatMessage[] = [
      makeMsg({
        id: 't1',
        role: 'tool' as const,
        content: 'output',
        tool_call_id: 'call-123',
      } as ChatMessage & { tool_call_id: string }),
    ] as ChatMessage[];

    const result = client.callFormatMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'tool', tool_call_id: 'call-123', content: 'output' });
  });

  it('should handle tool messages with toolResults', () => {
    const msgs: ChatMessage[] = [
      makeMsg({
        id: 't2',
        role: 'tool' as const,
        content: null,
        toolResults: [
          { toolCallId: 'call-1', output: 'result-1', isError: false },
          { toolCallId: 'call-2', output: 'result-2', isError: false },
        ],
      }),
    ];

    const result = client.callFormatMessages(msgs);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'tool', tool_call_id: 'call-1', content: 'result-1' });
    expect(result[1]).toEqual({ role: 'tool', tool_call_id: 'call-2', content: 'result-2' });
  });

  it('should handle assistant messages with toolCalls', () => {
    const msgs: ChatMessage[] = [
      makeMsg({
        id: 'a1',
        role: 'assistant' as const,
        content: null,
        toolCalls: [
          { id: 'tc-1', toolName: 'Bash', input: { command: 'ls' }, status: 'completed' as const },
        ],
      }),
    ];

    const result = client.callFormatMessages(msgs);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect((result[0].tool_calls as Array<Record<string, unknown>>)).toHaveLength(1);
    expect((result[0].tool_calls as Array<Record<string, unknown>>)[0].function).toEqual({
      name: 'Bash',
      arguments: JSON.stringify({ command: 'ls' }),
    });
  });

  it('should handle assistant messages with pre-formatted tool_calls', () => {
    const msgs: ChatMessage[] = [
      makeMsg({
        id: 'a2',
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          { id: 'tc-1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
        ],
      } as ChatMessage & { tool_calls?: unknown }),
    ] as ChatMessage[];

    const result = client.callFormatMessages(msgs);

    expect(result).toHaveLength(1);
    expect((result[0].tool_calls as Array<Record<string, unknown>>)).toHaveLength(1);
  });

  it('should fill empty assistant content', () => {
    const msgs: ChatMessage[] = [
      makeMsg({ id: 'a3', role: 'assistant' as const, content: null }),
    ];

    const result = client.callFormatMessages(msgs);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('(no response)');
  });
});

describe('BaseApiClient formatTools cache [P7]', () => {
  let client: TestClient;

  beforeEach(() => {
    client = new TestClient();
  });

  it('should return the same reference when called twice with the same tools', () => {
    const tools: ToolDefinition[] = [bashTool];

    const first = client.callFormatTools(tools);
    const second = client.callFormatTools(tools);

    expect(second).toBe(first);
  });

  it('should return different references for different tool sets', () => {
    const first = client.callFormatTools([bashTool]);
    const second = client.callFormatTools([readTool]);

    expect(second).not.toBe(first);
  });

  it('should format tools correctly', () => {
    const tools: ToolDefinition[] = [bashTool];
    const result = client.callFormatTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('type', 'function');
    expect((result[0].function as Record<string, unknown>).name).toBe('Bash');
    expect((result[0].function as Record<string, unknown>).description).toBe('Execute bash commands');
    expect((result[0].function as Record<string, unknown>).parameters).toHaveProperty('type');
  });

  it('should include parameters from schema', () => {
    const tools: ToolDefinition[] = [writeTool];
    const result = client.callFormatTools(tools);

    const params = (result[0].function as Record<string, unknown>).parameters as Record<string, unknown>;
    expect(params).toHaveProperty('properties');
    expect((params.properties as Record<string, unknown>).query).toBeDefined();
  });
});
