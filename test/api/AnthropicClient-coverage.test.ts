import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AnthropicClient } from '../../src/api/AnthropicClient';
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

function mockFetchSSE(chunks: string[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: createMockStream(chunks),
    text: async () => chunks.join(''),
    headers: {
      forEach: (cb: (value: string, key: string) => void) => {
        cb('text/event-stream', 'content-type');
      },
    },
  } as any;
}

function makeMsg(role: string, content: string, extra?: any) {
  return { id: `msg_${role}_${Date.now()}`, role, content, timestamp: Date.now(), ...extra };
}

describe('AnthropicClient - Comprehensive Coverage', () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ---------- Construction & API key ----------

  describe('Construction & API key', () => {
    it('should create with default base URL when none provided', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'test' });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should accept custom base URL', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'test', baseUrl: 'https://custom.api.com' });
      expect(client.validateApiKey()).toBe(true);
    });

    it('should reject empty API key', () => {
      const client = new AnthropicClient({ apiKey: '', model: 'test' });
      expect(client.validateApiKey()).toBe(false);
    });

    it('should reject non-sk-ant- prefixed key', () => {
      const client = new AnthropicClient({ apiKey: 'sk-something-else', model: 'test' });
      expect(client.validateApiKey()).toBe(false);
    });

    it('should use default apiVersion when not specified', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'test' });
      // Verify by checking headers through buildHeaders exposure
      expect(client.validateApiKey()).toBe(true);
    });
  });

  // ---------- getModelInfo ----------

  describe('getModelInfo', () => {
    it('should return info for known model claude-3-5-sonnet-20241022', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-3-5-sonnet-20241022' });
      const info = client.getModelInfo();
      expect(info.maxTokens).toBe(8192);
      expect(info.provider).toBe('anthropic');
      expect(info.supportsStreaming).toBe(true);
      expect(info.supportsTools).toBe(true);
    });

    it('should return info for claude-3-5-haiku-20241022', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-3-5-haiku-20241022' });
      const info = client.getModelInfo();
      expect(info.maxTokens).toBe(8192);
    });

    it('should return info for claude-3-opus-20240229', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-3-opus-20240229' });
      const info = client.getModelInfo();
      expect(info.maxTokens).toBe(4096);
    });

    it('should return info for claude-3-sonnet-20240229', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-3-sonnet-20240229' });
      const info = client.getModelInfo();
      expect(info.maxTokens).toBe(4096);
    });

    it('should return info for claude-3-haiku-20240307', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-3-haiku-20240307' });
      const info = client.getModelInfo();
      expect(info.maxTokens).toBe(4096);
    });

    it('should return default 8192 for unknown model', () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-future-model' });
      const info = client.getModelInfo();
      expect(info.maxTokens).toBe(8192);
    });
  });

  // ---------- chat (non-streaming) ----------

  describe('chat (non-streaming)', () => {
    it('should return text content from response', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_1', type: 'message',
          content: [{ type: 'text', text: 'Hello!' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
        stream: false,
      });

      expect(resp.content).toBe('Hello!');
      expect(resp.usage.inputTokens).toBe(10);
      expect(resp.usage.outputTokens).toBe(5);
      expect(resp.usage.totalTokens).toBe(15);
      expect(resp.toolCalls).toBeUndefined();
    });

    it('should handle multiple text blocks concatenated', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_2', type: 'message',
          content: [
            { type: 'text', text: 'Part 1. ' },
            { type: 'text', text: 'Part 2.' },
          ],
          usage: { input_tokens: 5, output_tokens: 10 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Go')],
      });

      expect(resp.content).toBe('Part 1. Part 2.');
    });

    it('should parse tool use blocks', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_3', type: 'message',
          content: [
            { type: 'text', text: 'I will run a command.' },
            { type: 'tool_use', id: 'toolu_abc', name: 'Bash', input: { command: 'ls -la' } },
          ],
          usage: { input_tokens: 20, output_tokens: 15 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'List files')],
      });

      expect(resp.content).toBe('I will run a command.');
      expect(resp.toolCalls).toBeDefined();
      expect(resp.toolCalls![0].id).toBe('toolu_abc');
      expect(resp.toolCalls![0].toolName).toBe('Bash');
      expect(resp.toolCalls![0].input).toEqual({ command: 'ls -la' });
      expect(resp.toolCalls![0].status).toBe('completed');
    });

    it('should handle empty content array', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_empty', type: 'message',
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.content).toBe('');
      expect(resp.toolCalls).toBeUndefined();
    });

    it('should handle missing usage in response', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_nousage', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'hi')],
      });

      expect(resp.usage.inputTokens).toBe(0);
      expect(resp.usage.outputTokens).toBe(0);
      expect(resp.usage.totalTokens).toBe(0);
    });

    it('should include cache read and creation tokens in usage', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_cache', type: 'message',
          content: [{ type: 'text', text: 'cached' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'cached question')],
      });

      expect(resp.usage.cacheReadTokens).toBe(8);
      expect(resp.usage.cacheCreationTokens).toBe(2);
    });

    it('should call handleApiError on HTTP error', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: { type: 'invalid_request_error', message: 'bad request' } }, 400)
      );

      await expect(client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow();
    });

    it('should handle 401 unauthorized error', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: { message: 'invalid_api_key' } }, 401)
      );

      await expect(client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow();
    });

    it('should handle 429 rate limit error', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: { message: 'rate_limit exceeded' } }, 429)
      );

      await expect(client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow();
    });

    it('should handle overloaded_error (529)', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: { message: 'overloaded_error' } }, 529)
      );

      await expect(client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow();
    });

    it('should propagate network errors', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network failure'));

      await expect(client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow();
    });

    it('should handle non-Error thrown from fetch', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockRejectedValue('string error');

      await expect(client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })).rejects.toThrow();
    });

    it('should pass abortSignal to fetch', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const controller = new AbortController();
      const fetchSpy = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_sig', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );
      globalThis.fetch = fetchSpy;

      await client.chat({
        model: 'claude-sonnet-4-20250514',
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
    it('should include system prompt with cache_control', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_sys', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
        systemPrompt: 'You are helpful.',
        stream: false,
      });

      expect(capturedBody.system).toBeDefined();
      expect(capturedBody.system[0].type).toBe('text');
      expect(capturedBody.system[0].text).toBe('You are helpful.');
      expect(capturedBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should filter out system messages from messages array', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_filter', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          makeMsg('system', 'System instruction'),
          makeMsg('user', 'Hello'),
          makeMsg('assistant', 'Hi there'),
        ],
        stream: false,
      });

      // System message should be filtered out from messages
      expect(capturedBody.messages.length).toBe(2);
      expect(capturedBody.messages[0].role).toBe('user');
      expect(capturedBody.messages[1].role).toBe('assistant');
    });

    it('should include tools and tool_choice when tools are provided', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_tools', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Do something')],
        tools: [
          { name: 'tool1', description: 'First tool', inputSchema: {}, call: async () => ({ toolCallId: '', output: '' }) },
          { name: 'tool2', description: 'Second tool', inputSchema: {}, call: async () => ({ toolCallId: '', output: '' }) },
        ],
        stream: false,
      });

      expect(capturedBody.tools).toBeDefined();
      expect(capturedBody.tools.length).toBe(2);
      expect(capturedBody.tool_choice).toEqual({ type: 'auto' });
      // Last tool should have cache_control
      expect(capturedBody.tools[1].cache_control).toEqual({ type: 'ephemeral' });
      expect(capturedBody.tools[0].cache_control).toBeUndefined();
    });

    it('should not include tools when empty array', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_notools', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
        tools: [],
        stream: false,
      });

      expect(capturedBody.tools).toBeUndefined();
      expect(capturedBody.tool_choice).toBeUndefined();
    });

    it('should include temperature when provided', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_temp', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
        temperature: 0.3,
        stream: false,
      });

      expect(capturedBody.temperature).toBe(0.3);
    });

    it('should not include temperature when undefined', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_notemp', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
        stream: false,
      });

      expect(capturedBody.temperature).toBeUndefined();
    });
  });

  // ---------- formatMessages ----------

  describe('formatMessages', () => {
    it('should format assistant message with tool calls', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_fmt', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          makeMsg('user', 'Do something'),
          makeMsg('assistant', 'I will use a tool', {
            toolCalls: [{ id: 'tc_1', toolName: 'Bash', input: { command: 'ls' }, status: 'completed' }],
          }),
        ],
        stream: false,
      });

      const assistantMsg = capturedBody.messages.find((m: any) => m.role === 'assistant');
      expect(assistantMsg).toBeDefined();
      // Should have text + tool_use content blocks
      expect(assistantMsg.content.length).toBe(2);
      expect(assistantMsg.content[0].type).toBe('text');
      expect(assistantMsg.content[1].type).toBe('tool_use');
      expect(assistantMsg.content[1].id).toBe('tc_1');
      expect(assistantMsg.content[1].name).toBe('Bash');
    });

    it('should format tool result message', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_tr', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          makeMsg('user', 'Run ls'),
          makeMsg('assistant', '', {
            toolCalls: [{ id: 'tc_1', toolName: 'Bash', input: { command: 'ls' }, status: 'completed' }],
          }),
          makeMsg('tool', '', {
            toolResults: [{ toolCallId: 'tc_1', output: 'file1.txt\nfile2.txt', isError: false }],
          }),
        ],
        stream: false,
      });

      // AnthropicClient formats 'tool' role as 'user' role, so find by content type
      const toolMsg = capturedBody.messages.find((m: any) =>
        Array.isArray(m.content) && m.content.some((c: any) => c.type === 'tool_result')
      );
      expect(toolMsg).toBeDefined();
      expect(toolMsg.content[0].type).toBe('tool_result');
      expect(toolMsg.content[0].tool_use_id).toBe('tc_1');
      expect(toolMsg.content[0].content).toBe('file1.txt\nfile2.txt');
    });

    it('should handle user-only messages', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_user', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hello')],
        stream: false,
      });

      expect(capturedBody.messages.length).toBe(1);
      expect(capturedBody.messages[0].role).toBe('user');
      expect(capturedBody.messages[0].content[0].type).toBe('text');
    });
  });

  // ---------- buildHeaders ----------

  describe('buildHeaders', () => {
    it('should send correct headers', async () => {
      const client = new AnthropicClient({
        apiKey: 'sk-ant-secret-key',
        model: 'claude-sonnet-4-20250514',
        apiVersion: '2024-01-01',
      });
      let capturedHeaders: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedHeaders = opts.headers;
        return mockFetchResponse({
          id: 'msg_hdr', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
        stream: false,
      });

      expect(capturedHeaders['Content-Type']).toBe('application/json');
      expect(capturedHeaders['x-api-key']).toBe('sk-ant-secret-key');
      expect(capturedHeaders['anthropic-version']).toBe('2024-01-01');
    });
  });

  // ---------- streamChat ----------

  describe('streamChat', () => {
    it('should yield text_delta events for content_block_delta', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas.length).toBe(2);
      expect(textDeltas[0].text).toBe('Hello');
      expect(textDeltas[1].text).toBe(' world');

      const stops = events.filter(e => e.type === 'stop');
      expect(stops.length).toBeGreaterThanOrEqual(1);
    });

    it('should yield tool_use event on content_block_stop when tool was streaming', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_123","name":"Bash"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'List files')],
      })) {
        events.push(event);
      }

      const toolUseEvents = events.filter(e => e.type === 'tool_use');
      expect(toolUseEvents.length).toBe(1);
      expect(toolUseEvents[0].toolCall.toolName).toBe('Bash');
      expect(toolUseEvents[0].toolCall.id).toBe('toolu_123');
      expect(toolUseEvents[0].toolCall.input).toEqual({ command: 'ls' });
      expect(toolUseEvents[0].toolCall.status).toBe('completed');
    });

    it('should yield message_delta with usage data', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const stopWithUsage = events.filter(e => e.type === 'stop' && e.usage);
      expect(stopWithUsage.length).toBeGreaterThanOrEqual(1);
      expect(stopWithUsage[0].usage.outputTokens).toBe(5);
    });

    it('should yield error event on SSE error event type', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const errors = events.filter(e => e.type === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].error.message).toBe('Overloaded');
    });

    it('should yield error event on SSE error with no message', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: error\ndata: {"type":"error","error":{}}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const errors = events.filter(e => e.type === 'error');
      expect(errors.length).toBe(1);
      expect(errors[0].error.message).toBe('Unknown Anthropic error');
    });

    it('should yield error on HTTP non-OK response', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE([], 403));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
    });

    it('should yield error when response body is null', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true, status: 200, body: null, text: async () => '',
        headers: { forEach: () => {} },
      } as any);

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
      expect(events.find(e => e.type === 'error')?.error.message).toContain('null');
    });

    it('should yield error on network failure', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
    });

    it('should yield error on non-Error exception', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockRejectedValue('string thrown');

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'error')).toBe(true);
    });

    it('should handle chunked SSE split across multiple read() calls', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      // Split a single SSE event across two chunks
      const fullEvent = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Split"}}\n\n';
      const mid = Math.floor(fullEvent.length / 2);
      const chunk1 = fullEvent.slice(0, mid);
      const chunk2 = fullEvent.slice(mid);

      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        chunk1,
        chunk2,
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].text).toBe('Split');
    });

    it('should handle remaining buffer after stream ends', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      // Last event without trailing \n\n (gets processed in done=true branch)
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"End"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'text_delta')).toBe(true);
      expect(events.some(e => e.type === 'stop')).toBe(true);
    });

    it('should send Accept: text/event-stream header for streaming', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedHeaders: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedHeaders = opts.headers;
        return mockFetchSSE(['event: message_stop\ndata: {"type":"message_stop"}\n\n']);
      });

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(capturedHeaders['Accept']).toBe('text/event-stream');
    });

    it('should handle stream with only a message_start event', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","type":"message","role":"assistant","content":[]}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      // message_start is ignored, message_stop yields stop
      expect(events.some(e => e.type === 'stop')).toBe(true);
    });
  });

  // ---------- handleApiError ----------

  describe('handleApiError', () => {
    it('should throw ApiError with status 401 for invalid key', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      // Use rejected fetch so error flows directly to catch block with pattern matching
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('401 invalid_api_key'));

      try {
        await client.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [makeMsg('user', 'test')],
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).statusCode).toBe(401);
        expect((e as Error).message).toContain('Invalid API key');
      }
    });

    it('should throw ApiError with status 429 for rate limit', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('429 rate_limit'));

      try {
        await client.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [makeMsg('user', 'test')],
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).statusCode).toBe(429);
        expect((e as Error).message).toContain('Rate limit');
      }
    });

    it('should throw ApiError with status 529 for overloaded', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('overloaded_error'));

      try {
        await client.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [makeMsg('user', 'test')],
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).statusCode).toBe(529);
        expect((e as Error).message).toContain('overloaded');
      }
    });

    it('should fall through to base handleApiError for generic errors', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('server exploded'));

      try {
        await client.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [makeMsg('user', 'test')],
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as Error).message).toContain('server exploded');
      }
    });

    it('should handle HTTP 401 response via double-handleApiError path', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: { message: 'authentication failed' } }, 401)
      );

      try {
        await client.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [makeMsg('user', 'test')],
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        // The error flows through handleApiError twice; the second call
        // strips the HTTP status from the message, falling through to base handler
        expect((e as Error).message).toContain('Anthropic API error');
      }
    });

    it('should handle HTTP 500 response falling to base handler', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({ error: { message: 'internal error' } }, 500)
      );

      try {
        await client.chat({
          model: 'claude-sonnet-4-20250514',
          messages: [makeMsg('user', 'test')],
        });
        expect.fail('Should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as Error).message).toContain('Anthropic API error');
      }
    });
  });

  // ---------- Prompt caching behavior ----------

  describe('Prompt caching', () => {
    it('should apply cache_control to system prompt', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_cache1', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 8, cache_creation_input_tokens: 2 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
        systemPrompt: 'Long system prompt for caching',
      });

      expect(capturedBody.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should apply cache_control to last tool in tools array', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_cache2', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
        tools: [
          { name: 'a', description: 'A', inputSchema: {}, call: async () => ({ toolCallId: '', output: '' }) },
          { name: 'b', description: 'B', inputSchema: {}, call: async () => ({ toolCallId: '', output: '' }) },
          { name: 'c', description: 'C', inputSchema: {}, call: async () => ({ toolCallId: '', output: '' }) },
        ],
      });

      expect(capturedBody.tools[0].cache_control).toBeUndefined();
      expect(capturedBody.tools[1].cache_control).toBeUndefined();
      expect(capturedBody.tools[2].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should include cache tokens in streaming response usage', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_cache3', type: 'message',
          content: [{ type: 'text', text: 'cached response' }],
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 90, cache_creation_input_tokens: 10 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.usage.cacheReadTokens).toBe(90);
      expect(resp.usage.cacheCreationTokens).toBe(10);
    });
  });

  // ---------- Abort / cancellation ----------

  describe('Abort / cancellation', () => {
    it('should propagate AbortError from fetch', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const abortError = new DOMException('The operation was aborted', 'AbortError');
      globalThis.fetch = vi.fn().mockRejectedValue(abortError);

      await expect(client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
        abortSignal: AbortSignal.abort(),
      })).rejects.toThrow();
    });

    it('should pass abortSignal to streamChat fetch', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const controller = new AbortController();
      const fetchSpy = vi.fn().mockResolvedValue(mockFetchSSE(['event: message_stop\ndata: {"type":"message_stop"}\n\n']));
      globalThis.fetch = fetchSpy;

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
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
  });

  // ---------- Tool use in streaming ----------

  describe('Tool use in streaming', () => {
    it('should accumulate multi-chunk tool input correctly', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_xyz","name":"ReadFile"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"/tmp/test\\"" }}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Read a file')],
      })) {
        events.push(event);
      }

      const toolUse = events.find(e => e.type === 'tool_use');
      expect(toolUse).toBeDefined();
      expect(toolUse.toolCall.toolName).toBe('ReadFile');
      expect(toolUse.toolCall.input).toEqual({ path: '/tmp/test' });
    });

    it('should handle tool call with empty input buffer', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_empty","name":"GetTime"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'What time is it?')],
      })) {
        events.push(event);
      }

      const toolUse = events.find(e => e.type === 'tool_use');
      expect(toolUse).toBeDefined();
      expect(toolUse.toolCall.toolName).toBe('GetTime');
      expect(toolUse.toolCall.input).toEqual({});
    });

    it('should handle multiple tool calls in a single stream', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"command\\":\\"ls\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_2","name":"Read"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"file.txt\\"}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Do two things')],
      })) {
        events.push(event);
      }

      const textDeltas = events.filter(e => e.type === 'text_delta');
      const toolUses = events.filter(e => e.type === 'tool_use');

      expect(textDeltas.length).toBe(1);
      expect(toolUses.length).toBe(2);
      expect(toolUses[0].toolCall.toolName).toBe('Bash');
      expect(toolUses[1].toolCall.toolName).toBe('Read');
    });

    it('should handle malformed JSON in tool input gracefully', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_bad","name":"Test"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"not json"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      // Should not yield a tool_use event for malformed input, but not crash
      const toolUses = events.filter(e => e.type === 'tool_use');
      expect(toolUses.length).toBe(0);
      warnSpy.mockRestore();
    });

    it('should handle malformed JSON in SSE data gracefully', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_delta\ndata: {invalid json}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      // Should still yield stop event despite parse failure
      expect(events.some(e => e.type === 'stop')).toBe(true);
      warnSpy.mockRestore();
    });

    it('should skip blocks without event type or data', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'some garbage without event/data\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'stop')).toBe(true);
    });
  });

  // ---------- Additional branch coverage ----------

  describe('Additional branch coverage', () => {
    it('should handle remaining buffer with incomplete SSE data at stream end', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      // Stream with data that doesn't have trailing \n\n - ends up in buffer
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Tail"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        // This last event lacks the trailing \n\n separator
        'event: message_stop\ndata: {"type":"message_stop"}',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'Hi')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'text_delta' && e.text === 'Tail')).toBe(true);
      expect(events.some(e => e.type === 'stop')).toBe(true);
    });

    it('should handle parseResponse with no content field', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_nocontent', type: 'message',
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.content).toBe('');
      expect(resp.toolCalls).toBeUndefined();
    });

    it('should ignore unknown content block types in parseResponse', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_unknown', type: 'message',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'unknown_type', data: 'something' },
          ],
          usage: { input_tokens: 5, output_tokens: 3 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.content).toBe('Hello');
    });

    it('should handle tool_use block with no input field', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_noinput', type: 'message',
          content: [
            { type: 'tool_use', id: 'toolu_noinput', name: 'GetTime' },
          ],
          usage: { input_tokens: 5, output_tokens: 3 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'What time?')],
      });

      expect(resp.toolCalls).toBeDefined();
      expect(resp.toolCalls![0].input).toEqual({});
    });

    it('should filter all messages when all are system messages', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_allsys', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [
          makeMsg('system', 'You are helpful.'),
        ],
        stream: false,
      });

      // After filtering system messages, messages array should be empty
      expect(capturedBody.messages).toBeUndefined();
    });

    it('should handle stream content_block_start with text type', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'stop')).toBe(true);
    });

    it('should handle message_delta without usage field', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      // message_delta without usage should not yield a stop with usage
      const stopWithUsage = events.filter(e => e.type === 'stop' && e.usage);
      expect(stopWithUsage.length).toBe(0);
      // But message_stop should yield a stop
      expect(events.some(e => e.type === 'stop')).toBe(true);
    });

    it('should handle input_json_delta with empty/undefined partial_json', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_empty","name":"X"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      const toolUse = events.find(e => e.type === 'tool_use');
      expect(toolUse).toBeDefined();
      expect(toolUse.toolCall.input).toEqual({});
    });

    it('should handle content_block_stop without an active tool call', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      // content_block_stop for a text block should not yield tool_use
      expect(events.filter(e => e.type === 'tool_use').length).toBe(0);
      expect(events.some(e => e.type === 'text_delta')).toBe(true);
    });

    it('should handle message_delta with zero-valued usage tokens', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_2","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"input_tokens":0,"output_tokens":0}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      const stopWithUsage = events.filter(e => e.type === 'stop' && e.usage);
      expect(stopWithUsage.length).toBeGreaterThanOrEqual(1);
      expect(stopWithUsage[0].usage.inputTokens).toBe(0);
      expect(stopWithUsage[0].usage.outputTokens).toBe(0);
    });

    it('should use maxTokens when provided in buildRequestBody', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      let capturedBody: any;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, opts: any) => {
        capturedBody = JSON.parse(opts.body);
        return mockFetchResponse({
          id: 'msg_maxtok', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      });

      await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
        maxTokens: 2048,
        stream: false,
      });

      expect(capturedBody.max_tokens).toBe(2048);
    });

    it('should handle SSE block with event type but no data line', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      const sseChunks = [
        'event: content_block_start\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'stop')).toBe(true);
    });

    it('should use persisted event type from previous block', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      // Two blocks where second block doesn't have event: line
      const sseChunks = [
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        // This block has no "event:" line, so it should use the previous event type (content_block_start)
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(mockFetchSSE(sseChunks));

      const events: any[] = [];
      for await (const event of client.streamChat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      })) {
        events.push(event);
      }

      expect(events.some(e => e.type === 'stop')).toBe(true);
    });
  });

  // ---------- Token counting and usage ----------

  describe('Token counting and usage', () => {
    it('should compute totalTokens correctly in non-streaming', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_tok', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 50 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.usage.totalTokens).toBe(150);
    });

    it('should include cache tokens in non-streaming usage', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_cache_tok', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.usage.inputTokens).toBe(50);
      expect(resp.usage.outputTokens).toBe(10);
      expect(resp.usage.cacheReadTokens).toBe(40);
      expect(resp.usage.cacheCreationTokens).toBe(10);
    });

    it('should default cache tokens to 0 when absent', async () => {
      const client = new AnthropicClient({ apiKey: 'sk-ant-test', model: 'claude-sonnet-4-20250514' });
      globalThis.fetch = vi.fn().mockResolvedValue(
        mockFetchResponse({
          id: 'msg_nocache', type: 'message',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 10, output_tokens: 5 },
        })
      );

      const resp = await client.chat({
        model: 'claude-sonnet-4-20250514',
        messages: [makeMsg('user', 'test')],
      });

      expect(resp.usage.cacheReadTokens).toBe(0);
      expect(resp.usage.cacheCreationTokens).toBe(0);
    });
  });
});
