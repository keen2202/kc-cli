import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaClient } from '../../src/api/OllamaClient';

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

function mockFetchNdjson(chunks: string[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: createMockStream(chunks),
    text: async () => chunks.join(''),
  } as any;
}

describe('OllamaClient', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('Construction', () => {
    it('should create with default base URL', () => {
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'llama3',
      });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should not require API key', () => {
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'llama3',
      });
      expect(client.validateApiKey()).toBe(true);
    });
  });

  describe('getModelInfo', () => {
    it('should return ollama model info', () => {
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'llama3',
      });
      const info = client.getModelInfo();
      expect(info.provider).toBe('ollama');
      expect(info.model).toBe('llama3');
      expect(info.supportsStreaming).toBe(true);
    });
  });

  describe('chat (non-streaming)', () => {
    it('should parse ollama response', async () => {
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'llama3',
      });

      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'Hello from Ollama!' },
          done: true,
        })
      );

      const response = await client.chat({
        model: 'llama3',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
        stream: false,
      });

      expect(response.content).toBe('Hello from Ollama!');
    });
  });

  describe('streamChat', () => {
    it('should parse NDJSON stream', async () => {
      const client = new OllamaClient({
        baseUrl: 'http://localhost:11434',
        model: 'llama3',
      });

      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"Hello"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":" world"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [{ id: '1', role: 'user', content: 'Hi', timestamp: Date.now() }],
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
    });
  });
});
