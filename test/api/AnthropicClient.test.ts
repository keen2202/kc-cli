import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicClient } from '../../src/api/AnthropicClient';

function mockFetchResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as any;
}

function createMockStream(chunks: string[]): ReadableStream {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]));
      } else {
        controller.close();
      }
    },
  });
}

function mockFetchSSE(chunks: string[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: createMockStream(chunks),
    text: async () => chunks.join(''),
  } as any;
}

describe('AnthropicClient', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('Construction', () => {
    it('should create with default API version', () => {
      const client = new AnthropicClient({
        apiKey: 'sk-ant-test123',
        model: 'claude-sonnet-4-20250514',
      });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should accept custom API version', () => {
      const client = new AnthropicClient({
        apiKey: 'sk-ant-test123',
        model: 'claude-sonnet-4-20250514',
        apiVersion: '2024-06-01',
      });
      expect(client.validateApiKey()).toBe(true);
    });
  });

  describe('validateApiKey', () => {
    it('should validate Anthropic key format', () => {
      const valid = new AnthropicClient({
        apiKey: 'sk-ant-api03-xxxxx',
        model: 'claude-sonnet-4-20250514',
      });
      expect(valid.validateApiKey()).toBe(true);

      const empty = new AnthropicClient({
        apiKey: '',
        model: 'claude-sonnet-4-20250514',
      });
      expect(empty.validateApiKey()).toBe(false);
    });
  });

  describe('getModelInfo', () => {
    it('should return Anthropic model info', () => {
      const client = new AnthropicClient({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-20250514',
      });
      const info = client.getModelInfo();
      expect(info.provider).toBe('anthropic');
      expect(info.model).toBe('claude-sonnet-4-20250514');
      expect(info.supportsStreaming).toBe(true);
      expect(info.supportsTools).toBe(true);
    });
  });

  describe('chat (non-streaming)', () => {
    it('should parse Anthropic response', async () => {
      const client = new AnthropicClient({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-20250514',
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_123',
          type: 'message',
          content: [{ type: 'text', text: 'Hello from Claude!' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      );

      const response = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
        stream: false,
      });

      expect(response.content).toBe('Hello from Claude!');
      expect(response.usage.inputTokens).toBe(10);
    });

    it('should parse Anthropic tool use blocks', async () => {
      const client = new AnthropicClient({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-20250514',
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_456',
          type: 'message',
          content: [
            { type: 'text', text: 'Let me check.' },
            { type: 'tool_use', id: 'toolu_001', name: 'Bash', input: { command: 'ls' } },
          ],
          usage: { input_tokens: 20, output_tokens: 10 },
        })
      );

      const response = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ id: '1', role: 'user', content: 'List files', timestamp: Date.now() }],
      });

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls![0].toolName).toBe('Bash');
    });
  });

  describe('streamChat', () => {
    it('should handle Anthropic SSE events', async () => {
      const client = new AnthropicClient({
        apiKey: 'sk-ant-test',
        model: 'claude-sonnet-4-20250514',
      });

      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
    });

    it('should yield error on API 401', async () => {
      const client = new AnthropicClient({
        apiKey: 'sk-ant-invalid',
        model: 'claude-sonnet-4-20250514',
      });

      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE([], 401));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
    });
  });
});
