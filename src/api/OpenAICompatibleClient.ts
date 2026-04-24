// OpenAI Compatible API Client
// Supports: OpenAI (GPT), Qwen (DashScope), GLM (Zhipu AI), and other OpenAI-compatible APIs

import { BaseApiClient } from './BaseApiClient';
import type { LLMStreamEvent, LLMRequestConfig, LLMResponse, TokenUsage } from './BaseApiClient';
import type { ToolCall } from '../types/message';

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: 'openai' | 'qwen' | 'glm';
}

export class OpenAICompatibleClient extends BaseApiClient {
  private provider: 'openai' | 'qwen' | 'glm';

  constructor(config: OpenAICompatibleConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
    this.provider = config.provider || 'openai';
  }

  /**
   * Send a chat completion request
   */
  async chat(config: LLMRequestConfig): Promise<LLMResponse> {
    const requestBody = this.buildRequestBody({ ...config, stream: false });
    const headers = this.buildHeaders();

    // Provider-specific endpoint
    const endpoint = this.getEndpoint();

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: config.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), 'OpenAI Compatible API error');
      }

      const data = await response.json();
      return this.parseResponse(data);
    } catch (error) {
      this.handleApiError(error, 'Failed to call OpenAI Compatible API');
    }
  }

  /**
   * Stream chat completion response
   */
  async *streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent> {
    const requestBody = this.buildRequestBody({ ...config, stream: true });
    const headers = {
      ...this.buildHeaders(),
      'Accept': 'text/event-stream',
    };

    const endpoint = this.getEndpoint();

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: config.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), 'OpenAI Compatible API error');
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
   * Validate API key format
   */
  validateApiKey(): boolean {
    // OpenAI, Qwen, GLM all use Bearer token format
    // Basic validation: non-empty string
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /**
   * Get model information
   */
  getModelInfo() {
    const modelInfo: Record<string, { maxTokens: number }> = {
      // OpenAI models
      'gpt-4': { maxTokens: 8192 },
      'gpt-4-turbo': { maxTokens: 128000 },
      'gpt-4o': { maxTokens: 128000 },
      'gpt-4o-mini': { maxTokens: 128000 },
      'gpt-3.5-turbo': { maxTokens: 16385 },
      // Qwen models
      'qwen-turbo': { maxTokens: 8192 },
      'qwen-plus': { maxTokens: 32768 },
      'qwen-max': { maxTokens: 32768 },
      'qwen-long': { maxTokens: 1000000 },
      // GLM models
      'glm-4': { maxTokens: 128000 },
      'glm-4-plus': { maxTokens: 128000 },
      'glm-4-flash': { maxTokens: 128000 },
      'glm-4-air': { maxTokens: 128000 },
    };

    const info = modelInfo[this.model] || { maxTokens: 128000 };

    return {
      provider: this.provider,
      model: this.model,
      maxTokens: info.maxTokens,
      supportsStreaming: true,
      supportsTools: true,
    };
  }

  /**
   * Get API endpoint based on provider
   */
  private getEndpoint(): string {
    switch (this.provider) {
      case 'openai':
        return '/v1/chat/completions';
      case 'qwen':
        // DashScope OpenAI-compatible endpoint
        return '/compatible-mode/v1/chat/completions';
      case 'glm':
        // Zhipu AI OpenAI-compatible endpoint
        return '/v4/chat/completions';
      default:
        return '/v1/chat/completions';
    }
  }

  /**
   * Build request headers with provider-specific headers
   */
  protected buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };

    // Provider-specific headers
    switch (this.provider) {
      case 'qwen':
        // DashScope may require specific headers
        headers['X-DashScope-SSE'] = 'enable';
        break;
      case 'glm':
        // Zhipu AI uses different auth header format
        headers['Authorization'] = `Bearer ${this.apiKey}`;
        break;
    }

    return headers;
  }

  /**
   * Parse non-streaming response
   */
  private parseResponse(data: any): LLMResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error('No choices in response');
    }

    const message = choice.message;
    const content = message?.content || '';
    const toolCalls: ToolCall[] = [];

    // Parse tool calls
    if (message?.tool_calls && Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        try {
          toolCalls.push({
            id: tc.id,
            toolName: tc.function?.name || '',
            input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
            status: 'completed',
          });
        } catch (error) {
          console.warn('Failed to parse tool call arguments:', error);
        }
      }
    }

    // Parse usage
    const usage: TokenUsage = {
      inputTokens: data.usage?.prompt_tokens || 0,
      outputTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0,
    };

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  /**
   * Parse streaming response
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

        // Parse SSE messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.slice(6);

            if (dataStr === '[DONE]') {
              yield { type: 'stop' };
              return;
            }

            try {
              const data = JSON.parse(dataStr);
              yield* this.parseStreamChunk(data);
            } catch (error) {
              console.warn('Failed to parse SSE chunk:', error);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Parse single stream chunk
   */
  private *parseStreamChunk(data: any): Generator<LLMStreamEvent> {
    const choice = data.choices?.[0];
    if (!choice) {
      return;
    }

    // Text delta
    if (choice.delta?.content && choice.finish_reason !== 'tool_calls') {
      yield {
        type: 'text_delta',
        text: choice.delta.content,
      };
    }

    // Tool calls
    if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls)) {
      for (const tc of choice.delta.tool_calls) {
        try {
          const toolCall: ToolCall = {
            id: tc.id || `tool_call_${Date.now()}`,
            toolName: tc.function?.name || '',
            input: tc.function?.arguments ? JSON.parse(tc.function.arguments) : {},
            status: 'completed',
          };

          yield {
            type: 'tool_use',
            toolCall,
          };
        } catch (error) {
          console.warn('Failed to parse tool call chunk:', error);
        }
      }
    }

    // Finish reason
    if (choice.finish_reason === 'stop') {
      // Parse usage if available
      if (data.usage) {
        yield {
          type: 'stop',
          usage: {
            inputTokens: data.usage.prompt_tokens || 0,
            outputTokens: data.usage.completion_tokens || 0,
            totalTokens: data.usage.total_tokens || 0,
          },
        };
      }
    }
  }

  /**
   * Handle API errors with provider-specific handling
   */
  protected handleApiError(error: unknown, context: string): never {
    if (error instanceof Error) {
      const message = error.message;

      // Common error patterns
      if (message.includes('401') || message.includes('Unauthorized')) {
        throw new Error(`${context}: Invalid API key`);
      }

      if (message.includes('429') || message.includes('rate limit')) {
        throw new Error(`${context}: Rate limit exceeded`);
      }

      if (message.includes('403') || message.includes('Forbidden')) {
        throw new Error(`${context}: Access forbidden. Check API key permissions`);
      }

      if (message.includes('model_not_found') || message.includes('invalid_model')) {
        throw new Error(`${context}: Model '${this.model}' not found`);
      }
    }

    super.handleApiError(error, context);
  }
}
