// Ollama API Client (Local LLM Server)

import { BaseApiClient, ApiError } from './BaseApiClient';
import type { LLMStreamEvent, LLMRequestConfig, LLMResponse, TokenUsage } from './BaseApiClient';
import type { ChatMessage, ToolCall } from '../types/message';
import type { ToolDefinition } from '../types/tools';

export interface OllamaConfig {
  baseUrl?: string;
  model: string;
}

export class OllamaClient extends BaseApiClient {
  constructor(config: OllamaConfig) {
    super({
      apiKey: '', // Ollama doesn't require API key
      baseUrl: config.baseUrl || 'http://localhost:11434',
      model: config.model,
    });
  }

  /**
   * Send a chat completion request
   */
  async chat(config: LLMRequestConfig): Promise<LLMResponse> {
    const requestBody = this.buildRequestBody({ ...config, stream: false });

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: config.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), 'Ollama API error', response);
      }

      const data = await response.json() as Record<string, unknown>;
      return this.parseResponse(data);
    } catch (error) {
      this.handleApiError(error, 'Failed to call Ollama API. Make sure Ollama is running');
    }
  }

  /**
   * Stream chat completion response
   */
  async *streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent> {
    const requestBody = this.buildRequestBody({ ...config, stream: true });

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody),
        signal: config.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), 'Ollama API error', response);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      yield* this.parseStreamResponse(response.body);
    } catch (error) {
      yield {
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }

  /**
   * Validate API key (Ollama doesn't require one)
   */
  validateApiKey(): boolean {
    return true;
  }

  /**
   * Get model information
   */
  getModelInfo() {
    // Ollama supports many models, context window varies
    const modelInfo: Record<string, { maxTokens: number }> = {
      'llama3': { maxTokens: 8192 },
      'llama3.1': { maxTokens: 128000 },
      'llama3.2': { maxTokens: 128000 },
      'llama3.3': { maxTokens: 128000 },
      'mistral': { maxTokens: 8192 },
      'mixtral': { maxTokens: 32768 },
      'qwen2': { maxTokens: 32768 },
      'qwen2.5': { maxTokens: 128000 },
      'gemma2': { maxTokens: 8192 },
      'phi3': { maxTokens: 128000 },
      'deepseek-coder': { maxTokens: 16384 },
      'codellama': { maxTokens: 100000 },
    };

    const info = modelInfo[this.model] || { maxTokens: 8192 };

    return {
      provider: 'ollama',
      model: this.model,
      maxTokens: info.maxTokens,
      supportsStreaming: true,
      supportsTools: true, // Depends on model capabilities
    };
  }

  /**
   * Build request body for Ollama API
   */
  protected buildRequestBody(config: LLMRequestConfig): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      stream: config.stream ?? true,
    };

    // Format messages
    const messages: Array<Record<string, unknown>> = [];

    if (config.systemPrompt) {
      messages.push({
        role: 'system',
        content: config.systemPrompt,
      });
    }

    messages.push(...this.formatMessages(config.messages));
    body.messages = messages;

    // Ollama options
    body.options = {
      temperature: config.temperature ?? 0.7,
      num_predict: config.maxTokens ?? 4096,
    };

    // Tools (Ollama 0.1.30+ supports function calling)
    if (config.tools && config.tools.length > 0) {
      body.tools = this.formatTools(config.tools);
    }

    return body;
  }

  /**
   * Parse non-streaming Response
   */
  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const message = data.message as Record<string, unknown> | undefined;
    if (!message) {
      throw new Error('No message in response');
    }

    const content = (message.content as string) || '';
    const toolCalls: ToolCall[] = [];

    // Parse tool calls (Ollama format)
    const rawToolCalls = message.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls) {
        const fn = tc.function as Record<string, unknown> | undefined;
        toolCalls.push({
          id: (tc.id as string) || `tool_call_${Date.now()}`,
          toolName: (fn?.name as string) || '',
          input: (fn?.arguments as Record<string, unknown>) || {},
          status: 'completed',
        });
      }
    }

    // Parse usage
    const usage: TokenUsage = {
      inputTokens: (data.prompt_eval_count as number) || 0,
      outputTokens: (data.eval_count as number) || 0,
      totalTokens: ((data.prompt_eval_count as number) || 0) + ((data.eval_count as number) || 0),
    };

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  /**
   * Parse streaming response using indexOf-based line parsing (avoids array allocation per chunk)
   */
  private async *parseStreamResponse(body: ReadableStream): AsyncGenerator<LLMStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines using indexOf to avoid array allocation
        let lineStart = 0;
        let shouldStop = false;

        while (!shouldStop) {
          const newlineIdx = buffer.indexOf('\n', lineStart);
          if (newlineIdx === -1) break;

          const line = buffer.slice(lineStart, newlineIdx);
          lineStart = newlineIdx + 1;

          if (line.length > 0) {
            try {
              const data = JSON.parse(line);
              yield* this.parseStreamChunk(data);
              if (data.done) {
                yield { type: 'stop' };
                shouldStop = true;
              }
            } catch (error) {
              console.warn('Failed to parse Ollama chunk:', error);
            }
          }
        }

        if (shouldStop) return;

        // Keep unprocessed remainder
        buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse single stream chunk
   */
  private *parseStreamChunk(data: Record<string, unknown>): Generator<LLMStreamEvent> {
    const message = data.message as Record<string, unknown> | undefined;

    // Text delta
    if (message?.content) {
      yield {
        type: 'text_delta',
        text: message.content as string,
      };
    }

    // Tool calls
    const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls) {
        try {
          const fn = tc.function as Record<string, unknown> | undefined;
          const toolCall: ToolCall = {
            id: (tc.id as string) || `tool_call_${Date.now()}`,
            toolName: (fn?.name as string) || '',
            input: (fn?.arguments as Record<string, unknown>) || {},
            status: 'completed',
          };

          yield {
            type: 'tool_use',
            toolCall,
          };
        } catch (error) {
          console.warn('Failed to parse Ollama tool call:', error);
        }
      }
    }

    // Usage (only in final chunk)
    if (data.done && data.prompt_eval_count !== undefined) {
      yield {
        type: 'stop',
        usage: {
          inputTokens: (data.prompt_eval_count as number) || 0,
          outputTokens: (data.eval_count as number) || 0,
          totalTokens: ((data.prompt_eval_count as number) || 0) + ((data.eval_count as number) || 0),
        },
      };
    }
  }

  /**
   * Handle API errors with Ollama-specific handling
   */
  protected handleApiError(error: unknown, context: string, response?: Response): never {
    if (error instanceof Error) {
      const message = error.message;

      // Connection refused - Ollama not running
      if (message.includes('ECONNREFUSED') || message.includes('fetch failed')) {
        throw new ApiError(`${context}: Cannot connect to Ollama at ${this.baseUrl}. Is Ollama running?`);
      }

      if (message.includes('model') && message.includes('not found')) {
        throw new ApiError(`${context}: Model '${this.model}' not found. Run 'ollama pull ${this.model}' first`, 404);
      }
    }

    super.handleApiError(error, context, response);
  }
}
