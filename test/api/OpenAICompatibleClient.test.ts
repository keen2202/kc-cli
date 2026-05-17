import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleClient } from '../../src/api/OpenAICompatibleClient';

// Mock ReadableStream for testing streaming responses
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

function mockFetchResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    body: null,
  } as any;
}

function mockFetchStream(chunks: string[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: createMockStream(chunks),
    text: async () => chunks.join(''),
  } as any;
}

describe('OpenAICompatibleClient', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('Construction', () => {
    it('should create client with OpenAI defaults', () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test123',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should create client for Qwen provider', () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'test-key',
        baseUrl: 'https://dashscope.aliyuncs.com',
        model: 'qwen-plus',
        provider: 'qwen',
      });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should create client for DeepSeek provider', () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'test-key',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
      });
      expect(client.validateApiKey()).toBe(true);
    });
  });

  describe('validateApiKey', () => {
    it('should return true for non-empty key', () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-valid-key',
        baseUrl: '',
        model: '',
      });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should return false for empty key', () => {
      const client = new OpenAICompatibleClient({
        apiKey: '',
        baseUrl: '',
        model: '',
      });
      expect(client.validateApiKey()).toBe(false);
    });
  });

  describe('getModelInfo', () => {
    it('should return model info for known model', () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'gpt-4',
      });
      const info = client.getModelInfo();
      expect(info.provider).toBe('openai');
      expect(info.model).toBe('gpt-4');
      expect(info.maxTokens).toBe(8192);
      expect(info.supportsStreaming).toBe(true);
      expect(info.supportsTools).toBe(true);
    });

    it('should return default for unknown model', () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'unknown-model-xyz',
      });
      const info = client.getModelInfo();
      expect(info.model).toBe('unknown-model-xyz');
      expect(info.maxTokens).toBe(128000);
    });

    it('should return DeepSeek model info', () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'deepseek-v4-pro',
        provider: 'deepseek',
      });
      const info = client.getModelInfo();
      expect(info.provider).toBe('deepseek');
    });

    it('should return Qwen model info', () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: '',
        model: 'qwen-plus',
        provider: 'qwen',
      });
      const info = client.getModelInfo();
      expect(info.provider).toBe('qwen');
    });
  });

  describe('chat (non-streaming)', () => {
    it('should parse text response', async () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          choices: [{ message: { content: 'Hello, world!' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      );

      const response = await client.chat({
        model: 'gpt-4',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
        stream: false,
      });

      expect(response.content).toBe('Hello, world!');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
    });

    it('should parse tool calls in response', async () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          choices: [{
            message: {
              content: 'Let me check.',
              tool_calls: [{
                id: 'call_123',
                function: { name: 'Bash', arguments: '{"command":"ls"}' },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        })
      );

      const response = await client.chat({
        model: 'gpt-4',
        messages: [{ id: '1', role: 'user', content: 'List files', timestamp: Date.now() }],
      });

      expect(response.toolCalls).toBeDefined();
      expect(response.toolCalls![0].toolName).toBe('Bash');
      expect(response.toolCalls![0].input).toEqual({ command: 'ls' });
    });

    it('should throw on HTTP error', async () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-invalid',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      });

      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchResponse({ error: 'Unauthorized' }, 401));

      await expect(
        client.chat({
          model: 'gpt-4',
          messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
        })
      ).rejects.toThrow(/Invalid API key/);
    });
  });

  describe('streamChat', () => {
    it('should yield text deltas from SSE stream', async () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      });

      const sseChunks = [
        'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n',
        'data: {"choices":[{"delta":{"content":" world"},"index":0}]}\n\n',
        'data: [DONE]\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchStream(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'gpt-4',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas).toHaveLength(2);
      expect(textDeltas[0].text).toBe('Hello');
      expect(textDeltas[1].text).toBe(' world');
    });

    it('should yield stop event', async () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      });

      const sseChunks = [
        'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n',
        'data: [DONE]\n\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchStream(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'gpt-4',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'stop')).toBe(true);
    });

    it('should yield error on fetch failure', async () => {
      const client = new OpenAICompatibleClient({
        apiKey: 'sk-test',
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4',
      });

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'gpt-4',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
    });
  });
});
