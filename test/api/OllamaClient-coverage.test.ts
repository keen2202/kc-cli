import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaClient } from '../../src/api/OllamaClient';
import { ApiError } from '../../src/api/BaseApiClient';

function mockFetchResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        cb('application/json', 'content-type');
      },
    },
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
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        cb('application/json', 'content-type');
      },
    },
  } as any;
}

function makeMsg(role: string, content: string, extra?: any) {
  return { id: `msg_${role}_${Date.now()}`, role, content, timestamp: Date.now(), ...extra };
}

describe('OllamaClient - Comprehensive Coverage', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ---------- Construction ----------

  describe('Construction', () => {
    it('should use default base URL when none provided', () => {
      const client = new OllamaClient({ model: 'llama3' });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should accept custom base URL', () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://192.168.1.100:11434' });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should always return true for validateApiKey', () => {
      const client = new OllamaClient({ model: 'test' });
      expect(client.validateApiKey()).toBe(true);
    });
  });

  // ---------- getModelInfo ----------

  describe('getModelInfo', () => {
    it('should return info for llama3 (8192)', () => {
      const client = new OllamaClient({ model: 'llama3' });
      const info = client.getModelInfo();
      expect(info.provider).toBe('ollama');
      expect(info.maxTokens).toBe(8192);
      expect(info.supportsStreaming).toBe(true);
      expect(info.supportsTools).toBe(true);
    });

    it('should return info for llama3.1 (128000)', () => {
      const client = new OllamaClient({ model: 'llama3.1' });
      expect(client.getModelInfo().maxTokens).toBe(128000);
    });

    it('should return info for llama3.2 (128000)', () => {
      const client = new OllamaClient({ model: 'llama3.2' });
      expect(client.getModelInfo().maxTokens).toBe(128000);
    });

    it('should return info for llama3.3 (128000)', () => {
      const client = new OllamaClient({ model: 'llama3.3' });
      expect(client.getModelInfo().maxTokens).toBe(128000);
    });

    it('should return info for mistral (8192)', () => {
      const client = new OllamaClient({ model: 'mistral' });
      expect(client.getModelInfo().maxTokens).toBe(8192);
    });

    it('should return info for mixtral (32768)', () => {
      const client = new OllamaClient({ model: 'mixtral' });
      expect(client.getModelInfo().maxTokens).toBe(32768);
    });

    it('should return info for qwen2 (32768)', () => {
      const client = new OllamaClient({ model: 'qwen2' });
      expect(client.getModelInfo().maxTokens).toBe(32768);
    });

    it('should return info for qwen2.5 (128000)', () => {
      const client = new OllamaClient({ model: 'qwen2.5' });
      expect(client.getModelInfo().maxTokens).toBe(128000);
    });

    it('should return info for gemma2 (8192)', () => {
      const client = new OllamaClient({ model: 'gemma2' });
      expect(client.getModelInfo().maxTokens).toBe(8192);
    });

    it('should return info for phi3 (128000)', () => {
      const client = new OllamaClient({ model: 'phi3' });
      expect(client.getModelInfo().maxTokens).toBe(128000);
    });

    it('should return info for deepseek-coder (16384)', () => {
      const client = new OllamaClient({ model: 'deepseek-coder' });
      expect(client.getModelInfo().maxTokens).toBe(16384);
    });

    it('should return info for codellama (100000)', () => {
      const client = new OllamaClient({ model: 'codellama' });
      expect(client.getModelInfo().maxTokens).toBe(100000);
    });

    it('should default to 8192 for unknown model', () => {
      const client = new OllamaClient({ model: 'unknown-model-xyz' });
      const info = client.getModelInfo();
      expect(info.maxTokens).toBe(8192);
      expect(info.model).toBe('unknown-model-xyz');
    });
  });

  // ---------- chat (non-streaming) ----------

  describe('chat (non-streaming)', () => {
    it('should parse basic response with content', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'Hello!' },
          done: true,
          prompt_eval_count: 15,
          eval_count: 10,
        })
      );

      const resp = await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
        stream: false,
      });

      expect(resp.content).toBe('Hello!');
      expect(resp.usage.inputTokens).toBe(15);
      expect(resp.usage.outputTokens).toBe(10);
      expect(resp.usage.totalTokens).toBe(25);
    });

    it('should parse response with tool calls', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc_1', function: { name: 'Bash', arguments: { command: 'ls' } } },
            ],
          },
          done: true,
          prompt_eval_count: 20,
          eval_count: 5,
        })
      );

      const resp = await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'List files')],
      });

      expect(resp.toolCalls).toBeDefined();
      expect(resp.toolCalls![0].toolName).toBe('Bash');
      expect(resp.toolCalls![0].input).toEqual({ command: 'ls' });
      expect(resp.toolCalls![0].id).toBe('tc_1');
    });

    it('should handle missing tool call id with generated id', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { function: { name: 'Test', arguments: { x: 1 } } },
            ],
          },
          done: true,
        })
      );

      const resp = await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.toolCalls).toBeDefined();
      expect(resp.toolCalls![0].id).toMatch(/^tool_call_/);
    });

    it('should handle missing function name in tool call', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc_x', function: { arguments: {} } },
            ],
          },
          done: true,
        })
      );

      const resp = await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.toolCalls![0].toolName).toBe('');
    });

    it('should handle missing function arguments in tool call', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              { id: 'tc_y', function: { name: 'Tool' } },
            ],
          },
          done: true,
        })
      );

      const resp = await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.toolCalls![0].input).toEqual({});
    });

    it('should handle empty content in message', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant' },
          done: true,
        })
      );

      const resp = await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.content).toBe('');
      expect(resp.toolCalls).toBeUndefined();
    });

    it('should handle missing usage counts (default to 0)', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'hi' },
          done: true,
        })
      );

      const resp = await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.usage.inputTokens).toBe(0);
      expect(resp.usage.outputTokens).toBe(0);
      expect(resp.usage.totalTokens).toBe(0);
    });

    it('should throw error when message is missing from response', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          done: true,
        })
      );

      await expect(client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow('No message in response');
    });

    it('should handle HTTP error response', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: 'model not found' }, 404)
      );

      await expect(client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow();
    });

    it('should handle connection refused error', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed ECONNREFUSED'));

      await expect(client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow('Cannot connect to Ollama');
    });

    it('should handle generic fetch failure', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

      await expect(client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow('Cannot connect to Ollama');
    });

    it('should handle model not found error', async () => {
      const client = new OllamaClient({ model: 'nonexistent', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('model not found'));

      await expect(client.chat({
        model: 'nonexistent',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow("Model 'nonexistent' not found");
    });

    it('should handle non-Error thrown from fetch', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue('string error');

      await expect(client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow();
    });

    it('should pass abortSignal to fetch', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const controller = new AbortController();
      const fetchSpy = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        })
      );
      globalThis.fetch = fetchSpy;

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
        abortSignal: controller.signal,
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: controller.signal }),
      );
    });
  });

  // ---------- buildRequestBody ----------

  describe('buildRequestBody', () => {
    it('should include system prompt', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
        systemPrompt: 'You are a coding assistant.',
      });

      expect(capturedBody.messages[0].role).toBe('system');
      expect(capturedBody.messages[0].content).toBe('You are a coding assistant.');
    });

    it('should include tools when provided', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
        tools: [
          { name: 'tool1', description: 'A tool', inputSchema: {}, call: async () => ({ toolCallId: '', output: '' }) },
        ],
      });

      expect(capturedBody.tools).toBeDefined();
      expect(capturedBody.tools.length).toBe(1);
    });

    it('should not include tools when empty', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
        tools: [],
      });

      expect(capturedBody.tools).toBeUndefined();
    });

    it('should set default temperature and num_predict in options', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      });

      expect(capturedBody.options.temperature).toBe(0.7);
      expect(capturedBody.options.num_predict).toBe(4096);
    });

    it('should use custom temperature and maxTokens', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
        temperature: 0.2,
        maxTokens: 2000,
      });

      expect(capturedBody.options.temperature).toBe(0.2);
      expect(capturedBody.options.num_predict).toBe(2000);
    });

    it('should set stream to false for non-streaming chat', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
        stream: false,
      });

      expect(capturedBody.stream).toBe(false);
    });
  });

  // ---------- streamChat ----------

  describe('streamChat', () => {
    it('should parse NDJSON stream with text deltas', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"Hello"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":" world"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":10,"eval_count":5}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas.length).toBe(2);
      expect(textDeltas[0].text).toBe('Hello');
      expect(textDeltas[1].text).toBe(' world');
    });

    it('should yield stop event when done is true with usage', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"Hi"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":20,"eval_count":8}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const stops = events.filter(e => e.type === 'stop');
      expect(stops.length).toBeGreaterThanOrEqual(1);
      // The last stop should have usage from the done chunk
      const lastStop = stops[stops.length - 1];
      if (lastStop.usage) {
        expect(lastStop.usage.inputTokens).toBe(20);
        expect(lastStop.usage.outputTokens).toBe(8);
      }
    });

    it('should yield tool_use events from stream chunks', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"","tool_calls":[{"id":"tc_1","function":{"name":"Bash","arguments":{"command":"ls"}}}]},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'List files')],
      })) {
        events.push(event);
      }

      const toolUseEvents = events.filter(e => e.type === 'tool_use');
      expect(toolUseEvents.length).toBe(1);
      expect(toolUseEvents[0].toolCall.toolName).toBe('Bash');
      expect(toolUseEvents[0].toolCall.input).toEqual({ command: 'ls' });
    });

    it('should handle tool call with missing id (generated)', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"Tool","arguments":{"x":1}}}]},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      const toolUseEvents = events.filter(e => e.type === 'tool_use');
      expect(toolUseEvents[0].toolCall.id).toMatch(/^tool_call_/);
    });

    it('should handle tool call with missing function name and arguments', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"","tool_calls":[{"id":"tc_x","function":{}}]},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      const toolUseEvents = events.filter(e => e.type === 'tool_use');
      expect(toolUseEvents[0].toolCall.toolName).toBe('');
      expect(toolUseEvents[0].toolCall.input).toEqual({});
    });

    it('should handle chunked NDJSON split across read() calls', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const fullLine = '{"model":"llama3","message":{"role":"assistant","content":"SplitLine"},"done":false}\n';
      const mid = Math.floor(fullLine.length / 2);
      const chunk1 = fullLine.slice(0, mid);
      const chunk2 = fullLine.slice(mid);

      const ndjsonChunks = [chunk1, chunk2, '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n'];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas.some(e => e.text === 'SplitLine')).toBe(true);
    });

    it('should skip empty lines in NDJSON stream', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '\n',
        '{"model":"llama3","message":{"role":"assistant","content":"ok"},"done":false}\n',
        '\n\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].text).toBe('ok');
    });

    it('should handle malformed JSON in stream gracefully', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        'not valid json\n',
        '{"model":"llama3","message":{"role":"assistant","content":"ok"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      // Should still process the valid line
      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas.length).toBe(1);
      warnSpy.mockRestore();
    });

    it('should handle failed tool call parse in stream chunk', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      // Simulate a chunk with tool_calls that throws during parsing
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"X","arguments":"not-an-object"}}]},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      // Should not crash
      expect(events.some(e => e.type === 'stop')).toBe(true);
      warnSpy.mockRestore();
    });

    it('should yield error on HTTP non-OK response in stream', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson([], 500));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
    });

    it('should yield error when response body is null', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, body: null, text: async () => '',
        headers: { forEach: () => {} },
      } as any);

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
      expect(events.find(e => e.type === 'error')?.error.message).toContain('null');
    });

    it('should yield error on connection refused in stream', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
    });

    it('should yield error on non-Error exception in stream', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue('string thrown');

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
    });

    it('should set stream to true in request body', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchNdjson(['{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n']);
      });

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      expect(capturedBody.stream).toBe(true);
    });

    it('should pass abortSignal to stream fetch', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const controller = new AbortController();
      const fetchSpy = vi.fn().mockResolvedValue(
        mockFetchNdjson(['{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n'])
      );
      globalThis.fetch = fetchSpy;

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
        abortSignal: controller.signal,
      })) {
        events.push(event);
      }

      expect(fetchSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('should stop reading after done=true', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"first"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
        '{"model":"llama3","message":{"role":"assistant","content":"should not appear"},"done":false}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].text).toBe('first');
    });
  });

  // ---------- handleApiError ----------

  describe('handleApiError', () => {
    it('should throw ApiError for ECONNREFUSED', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:11434'));

      try {
        await client.chat({ model: 'llama3', messages: [makeMsg('user', 'test')] });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as Error).message).toContain('Cannot connect to Ollama');
      }
    });

    it('should throw ApiError for fetch failed', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

      try {
        await client.chat({ model: 'llama3', messages: [makeMsg('user', 'test')] });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as Error).message).toContain('Cannot connect to Ollama');
      }
    });

    it('should throw ApiError for model not found', async () => {
      const client = new OllamaClient({ model: 'my-custom-model', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('model not found'));

      try {
        await client.chat({ model: 'my-custom-model', messages: [makeMsg('user', 'test')] });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).statusCode).toBe(404);
        expect((e as Error).message).toContain("my-custom-model");
        expect((e as Error).message).toContain("ollama pull");
      }
    });

    it('should fall through to base handleApiError for generic errors', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: 'unknown error' }, 500)
      );

      try {
        await client.chat({ model: 'llama3', messages: [makeMsg('user', 'test')] });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
      }
    });
  });

  // ---------- Connection and request formatting ----------

  describe('Connection and request formatting', () => {
    it('should send POST to /api/chat endpoint', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://myhost:9999' });
      const fetchSpy = vi.fn().mockResolvedValue(
        mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        })
      );
      globalThis.fetch = fetchSpy;

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      });

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://myhost:9999/api/chat',
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('should send Content-Type application/json header', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedHeaders: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedHeaders = opts.headers;
        return mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      });

      expect(capturedHeaders['Content-Type']).toBe('application/json');
    });

    it('should include model name in request body', async () => {
      const client = new OllamaClient({ model: 'mistral', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          model: 'mistral',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'mistral',
        messages: [makeMsg('user', 'test')],
      });

      expect(capturedBody.model).toBe('mistral');
    });

    it('should format multiple messages correctly', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          model: 'llama3',
          message: { role: 'assistant', content: 'ok' },
          done: true,
        });
      });

      await client.chat({
        model: 'llama3',
        messages: [
          makeMsg('user', 'Question 1'),
          makeMsg('assistant', 'Answer 1'),
          makeMsg('user', 'Question 2'),
        ],
      });

      // System prompt + 3 messages = 4 (or just 3 if no system prompt)
      const userMessages = capturedBody.messages.filter((m: any) => m.role === 'user');
      expect(userMessages.length).toBe(2);
    });
  });

  // ---------- Token usage in streaming ----------

  describe('Token usage in streaming', () => {
    it('should yield stop with usage on done chunk with eval counts', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"Hi"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true,"prompt_eval_count":50,"eval_count":20}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      const stops = events.filter(e => e.type === 'stop');
      expect(stops.length).toBeGreaterThanOrEqual(1);
      const usageStop = stops.find(e => e.usage);
      if (usageStop) {
        expect(usageStop.usage.inputTokens).toBe(50);
        expect(usageStop.usage.outputTokens).toBe(20);
        expect(usageStop.usage.totalTokens).toBe(70);
      }
    });

    it('should not yield stop with usage when done=true but no eval counts', async () => {
      const client = new OllamaClient({ model: 'llama3', baseUrl: 'http://localhost:11434' });
      const ndjsonChunks = [
        '{"model":"llama3","message":{"role":"assistant","content":"ok"},"done":false}\n',
        '{"model":"llama3","message":{"role":"assistant","content":""},"done":true}\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchNdjson(ndjsonChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'llama3',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      // Should still yield stop
      expect(events.some(e => e.type === 'stop')).toBe(true);
    });
  });
});
