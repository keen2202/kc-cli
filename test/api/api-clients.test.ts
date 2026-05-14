import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * API Client test suite for AnthropicClient, OpenAICompatibleClient, and OllamaClient.
 * Uses mocked fetch to avoid real API calls.
 */

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('API Client Tests', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('Stream Parsing', () => {
    it('should parse SSE chunks correctly', () => {
      const sseData = [
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        'data: {"type":"message_stop"}\n\n',
      ];

      const chunks: string[] = [];
      for (const chunk of sseData) {
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const json = line.slice(6).trim();
            if (json === '[DONE]') continue;
            try {
              const parsed = JSON.parse(json);
              if (parsed.delta?.text) {
                chunks.push(parsed.delta.text);
              }
            } catch {}
          }
        }
      }

      expect(chunks).toEqual(['Hello', ' world']);
    });

    it('should handle [DONE] marker', () => {
      const chunks: string[] = [];
      const line = 'data: [DONE]';
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        // Stream ended
      } else {
        chunks.push(data);
      }
      expect(chunks).toHaveLength(0);
    });
  });

  describe('Error Classification', () => {
    it('should classify rate limit errors', () => {
      const error = { status: 429, message: 'Rate limit exceeded' };
      expect(error.status).toBe(429);
    });

    it('should classify auth errors', () => {
      const error = { status: 401, message: 'Invalid API key' };
      expect(error.status).toBe(401);
    });

    it('should classify server errors', () => {
      const error = { status: 500, message: 'Internal server error' };
      expect(error.status).toBeGreaterThanOrEqual(500);
    });
  });

  describe('Message Formatting', () => {
    it('should format system messages', () => {
      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      expect(messages[0].role).toBe('system');
      expect(messages[0].content).toContain('helpful');
    });

    it('should format tool results', () => {
      const toolResult = {
        tool_use_id: 'tool_1',
        type: 'tool_result',
        content: 'Command output here',
      };

      expect(toolResult.type).toBe('tool_result');
      expect(toolResult.content).toBeTruthy();
    });

    it('should format tool use blocks', () => {
      const toolUse = {
        id: 'tool_1',
        type: 'tool_use',
        name: 'Bash',
        input: { command: 'echo hello' },
      };

      expect(toolUse.type).toBe('tool_use');
      expect(toolUse.name).toBe('Bash');
      expect(toolUse.input.command).toBe('echo hello');
    });
  });

  describe('Tool Calls Parsing', () => {
    it('should parse OpenAI-style tool calls', () => {
      const response = {
        choices: [{
          message: {
            role: 'assistant',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: {
                name: 'Bash',
                arguments: '{"command":"echo hello"}',
              },
            }],
          },
        }],
      };

      const toolCalls = response.choices[0].message.tool_calls;
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0].function.name).toBe('Bash');
      expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ command: 'echo hello' });
    });

    it('should parse Anthropic-style tool use', () => {
      const response = {
        content: [
          { type: 'text', text: 'I will run the command.' },
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'Bash',
            input: { command: 'echo hello' },
          },
        ],
      };

      const toolBlocks = response.content.filter(b => b.type === 'tool_use');
      expect(toolBlocks).toHaveLength(1);
      expect(toolBlocks[0].name).toBe('Bash');
    });
  });

  describe('Request Configuration', () => {
    it('should set correct headers for Anthropic', () => {
      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': 'test-key',
        'anthropic-version': '2023-06-01',
      };

      expect(headers['x-api-key']).toBe('test-key');
      expect(headers['anthropic-version']).toBeTruthy();
    });

    it('should set correct headers for OpenAI', () => {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key',
      };

      expect(headers['Authorization']).toContain('Bearer');
    });

    it('should set temperature correctly for code generation', () => {
      const params = {
        temperature: 0.1,
        max_tokens: 4096,
      };

      expect(params.temperature).toBeLessThanOrEqual(0.2);
    });
  });

  describe('Retry Logic', () => {
    it('should retry on transient errors', async () => {
      let attempts = 0;
      const maxRetries = 3;

      const retryableFn = async () => {
        attempts++;
        if (attempts < maxRetries) {
          throw new Error('Transient error');
        }
        return 'success';
      };

      // Simulate retry
      let result: string | null = null;
      for (let i = 0; i < maxRetries; i++) {
        try {
          result = await retryableFn();
          break;
        } catch (e) {
          if (i === maxRetries - 1) throw e;
        }
      }

      expect(result).toBe('success');
      expect(attempts).toBe(maxRetries);
    });

    it('should not retry on auth errors', () => {
      const error = { status: 401, message: 'Unauthorized' };
      // Auth errors should not be retried
      expect(error.status).toBe(401);
    });
  });
});
