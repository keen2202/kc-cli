import { describe, it, expect } from 'vitest';
import { BaseApiClient } from '../../src/api/BaseApiClient';
import type { LLMRequestConfig, LLMResponse, LLMStreamEvent } from '../../src/api/BaseApiClient';
import type { ChatMessage } from '../../src/types/message';

// Create a concrete subclass for testing
class TestApiClient extends BaseApiClient {
  async chat(): Promise<LLMResponse> {
    return { content: 'test', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
  }

  async *streamChat(): AsyncGenerator<LLMStreamEvent> {
    yield { type: 'text_delta', text: 'hello' };
    yield { type: 'stop' };
  }

  validateApiKey(): boolean {
    return this.apiKey.length > 0;
  }

  getModelInfo() {
    return {
      provider: 'test',
      model: this.model,
      maxTokens: 4096,
      supportsStreaming: true,
      supportsTools: true,
    };
  }

  // Expose protected methods for testing
  public testBuildRequestBody(config: LLMRequestConfig) {
    return this.buildRequestBody(config);
  }

  public testFormatMessages(messages: ChatMessage[]) {
    return this.formatMessages(messages);
  }

  public testFormatTools(tools: any[]) {
    return this.formatTools(tools);
  }

  public testBuildHeaders() {
    return this.buildHeaders();
  }

  public testHandleApiError(error: unknown, context: string) {
    return this.handleApiError(error, context);
  }

  public testExtractSchemaParameters(schema: any) {
    return this.extractSchemaParameters(schema);
  }
}

describe('BaseApiClient', () => {
  const client = new TestApiClient({
    apiKey: 'test-key',
    baseUrl: 'https://api.test.com',
    model: 'test-model',
  });

  it('should construct with config', () => {
    expect(client.validateApiKey()).toBe(true);
  });

  it('should return model info', () => {
    const info = client.getModelInfo();
    expect(info.provider).toBe('test');
    expect(info.model).toBe('test-model');
    expect(info.maxTokens).toBe(4096);
    expect(info.supportsStreaming).toBe(true);
    expect(info.supportsTools).toBe(true);
  });

  it('should validate non-empty api key', () => {
    const empty = new TestApiClient({ apiKey: '', baseUrl: '', model: '' });
    expect(empty.validateApiKey()).toBe(false);
  });

  describe('buildRequestBody', () => {
    it('should build basic body', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [{ role: 'user', content: 'hello' }],
      });
      expect(body.model).toBe('test-model');
      expect(body.stream).toBe(true);
    });

    it('should include system prompt', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [],
        systemPrompt: 'You are helpful',
      });
      expect(body.system).toBe('You are helpful');
    });

    it('should include maxTokens', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [],
        maxTokens: 1000,
      });
      expect(body.max_tokens).toBe(1000);
    });

    it('should include temperature', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [],
        temperature: 0.7,
      });
      expect(body.temperature).toBe(0.7);
    });

    it('should not include temperature when undefined', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [],
      });
      expect(body.temperature).toBeUndefined();
    });

    it('should include tools', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [],
        tools: [{
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: {},
          call: async () => ({ toolCallId: '', output: '' }),
        }],
      });
      expect(body.tools).toBeDefined();
      expect((body.tools as any[]).length).toBe(1);
    });

    it('should not include empty tools array', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [],
        tools: [],
      });
      expect(body.tools).toBeUndefined();
    });

    it('should set stream to false when specified', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [],
        stream: false,
      });
      expect(body.stream).toBe(false);
    });
  });

  describe('formatMessages', () => {
    it('should format simple messages', () => {
      const result = client.testFormatMessages([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toBe('hello');
      expect(result[1].role).toBe('assistant');
    });

    it('should format assistant message with tool calls', () => {
      const result = client.testFormatMessages([{
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: 'call_1',
          toolName: 'Bash',
          input: { command: 'ls' },
        }],
      }]);
      expect(result[0].tool_calls).toBeDefined();
      expect((result[0].tool_calls as any[])[0].id).toBe('call_1');
    });

    it('should format tool result message', () => {
      const result = client.testFormatMessages([{
        role: 'tool',
        content: '',
        toolResults: [{
          toolCallId: 'call_1',
          output: 'file.txt',
          isError: false,
        }],
      }]);
      expect(result[0].content).toBe('file.txt');
    });
  });

  describe('formatTools', () => {
    it('should format tool definitions', () => {
      const result = client.testFormatTools([{
        name: 'my_tool',
        description: 'Does something',
        inputSchema: { type: 'object' },
        call: async () => ({ toolCallId: '', output: '' }),
      }]);
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('function');
      expect((result[0].function as any).name).toBe('my_tool');
      expect((result[0].function as any).description).toBe('Does something');
    });
  });

  describe('buildHeaders', () => {
    it('should return content-type and auth headers', () => {
      const headers = client.testBuildHeaders();
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Authorization']).toBe('Bearer test-key');
    });
  });

  describe('handleApiError', () => {
    it('should throw Error with context', () => {
      expect(() => client.testHandleApiError(new Error('fail'), 'Chat')).toThrow('Chat: fail');
    });

    it('should throw for non-Error', () => {
      expect(() => client.testHandleApiError('string error', 'Stream')).toThrow('Stream: string error');
    });
  });

  describe('extractSchemaParameters', () => {
    it('should return placeholder schema', () => {
      const result = client.testExtractSchemaParameters({});
      expect(result.type).toBe('object');
      expect(result.properties).toEqual({});
      expect(result.required).toEqual([]);
    });
  });

  describe('chat and streamChat', () => {
    it('should return chat response', async () => {
      const result = await client.chat({ model: 'test', messages: [] });
      expect(result.content).toBe('test');
      expect(result.usage.totalTokens).toBe(15);
    });

    it('should yield stream events', async () => {
      const events: LLMStreamEvent[] = [];
      for await (const event of client.streamChat({ model: 'test', messages: [] })) {
        events.push(event);
      }
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe('text_delta');
      expect(events[1].type).toBe('stop');
    });
  });

  describe('formatMessages edge cases', () => {
    it('should handle multiple tool results in one message', () => {
      const result = client.testFormatMessages([{
        role: 'tool',
        content: '',
        toolResults: [
          { toolCallId: 'call_1', output: 'result1', isError: false },
          { toolCallId: 'call_2', output: 'result2', isError: false },
        ],
      }]);
      // Implementation may combine or split - just verify both results are present
      expect(result.length).toBeGreaterThanOrEqual(1);
      const allContent = result.map((r: any) => r.content || '').join(' ');
      expect(allContent).toContain('result1');
      expect(allContent).toContain('result2');
    });

    it('should handle system messages', () => {
      const result = client.testFormatMessages([
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'hello' },
      ]);
      expect(result).toHaveLength(2);
      expect(result[0].role).toBe('system');
    });

    it('should handle empty messages array', () => {
      const result = client.testFormatMessages([]);
      expect(result).toHaveLength(0);
    });

    it('should handle assistant message with content and tool calls', () => {
      const result = client.testFormatMessages([{
        role: 'assistant',
        content: 'Let me check that for you.',
        toolCalls: [{
          id: 'call_1',
          toolName: 'Bash',
          input: { command: 'ls' },
        }],
      }]);
      expect(result[0].content).toBe('Let me check that for you.');
      expect(result[0].tool_calls).toBeDefined();
    });
  });

  describe('formatTools edge cases', () => {
    it('should handle multiple tools', () => {
      const result = client.testFormatTools([
        { name: 'tool1', description: 'First', inputSchema: {}, call: async () => ({ toolCallId: '', output: '' }) },
        { name: 'tool2', description: 'Second', inputSchema: {}, call: async () => ({ toolCallId: '', output: '' }) },
      ]);
      expect(result).toHaveLength(2);
      expect((result[0].function as any).name).toBe('tool1');
      expect((result[1].function as any).name).toBe('tool2');
    });

    it('should handle tool with complex inputSchema', () => {
      const result = client.testFormatTools([{
        name: 'complex_tool',
        description: 'A tool with complex params',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            options: {
              type: 'object',
              properties: {
                recursive: { type: 'boolean' },
              },
            },
          },
          required: ['path'],
        },
        call: async () => ({ toolCallId: '', output: '' }),
      }]);
      expect(result).toHaveLength(1);
    });
  });

  describe('buildRequestBody edge cases', () => {
    it('should handle all optional parameters', () => {
      const body = client.testBuildRequestBody({
        model: 'test-model',
        messages: [],
        maxTokens: 2000,
        temperature: 0.5,
        topP: 0.9,
        systemPrompt: 'test',
        stream: false,
      });
      expect(body.model).toBe('test-model');
      expect(body.max_tokens).toBe(2000);
      expect(body.temperature).toBe(0.5);
      expect(body.stream).toBe(false);
      expect(body.system).toBe('test');
    });
  });
});
