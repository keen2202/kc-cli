// OpenAI Compatible API Client
// Supports: OpenAI (GPT), Qwen (DashScope), GLM (Zhipu AI), and other OpenAI-compatible APIs
// Cache optimization: byte-stable serialization for DeepSeek auto-prefix caching

import { BaseApiClient, ApiError } from './BaseApiClient';
import type { LLMStreamEvent, LLMRequestConfig, LLMResponse, TokenUsage } from './BaseApiClient';
import type { ChatMessage, ToolCall } from '../types/message';
import type { ToolDefinition } from '../types/tools';
import { canonicalStringify } from '../services/cachePrefix';

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: 'openai' | 'qwen' | 'glm' | 'deepseek';
}

export class OpenAICompatibleClient extends BaseApiClient {
  private provider: 'openai' | 'qwen' | 'glm' | 'deepseek';
  private frozenToolSpecs: Array<Record<string, unknown>> | null = null;

  constructor(config: OpenAICompatibleConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
    });
    this.provider = config.provider || 'openai';
  }

  /**
   * Build request body with cache-aware serialization.
   * For DeepSeek: use canonical JSON (sorted keys) to ensure byte-stable prefixes.
   * For OpenAI: add prompt_cache param on supported models.
   * Ephemeral content is appended to the last user message to keep the prefix stable.
   */
  protected buildRequestBody(config: LLMRequestConfig): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.formatMessagesCacheAware(config.messages, config.ephemeralContent),
      stream: config.stream ?? true,
    };

    // System prompt: use as-is (stable portion from CachePrefixService)
    if (config.systemPrompt) {
      body.system = config.systemPrompt;
    }

    if (config.maxTokens) {
      body.max_tokens = config.maxTokens;
    }

    if (config.temperature !== undefined) {
      body.temperature = config.temperature;
    }

    if (config.tools && config.tools.length > 0) {
      body.tools = this.formatToolsCacheAware(config.tools);
    }

    // OpenAI: enable prompt caching for supported models
    if (this.provider === 'openai') {
      body.prompt_cache = true;
    }

    return body;
  }

  /**
   * Format messages with byte-stable serialization.
   * Appends ephemeral content to the last user message so it stays outside the cached prefix.
   */
  private formatMessagesCacheAware(messages: ChatMessage[], ephemeralContent?: string): Array<Record<string, unknown>> {
    const formatted = this.formatMessages(messages);

    // Append ephemeral content to the last user message
    if (ephemeralContent && formatted.length > 0) {
      for (let i = formatted.length - 1; i >= 0; i--) {
        if (formatted[i].role === 'user') {
          const existing = formatted[i].content;
          formatted[i].content = typeof existing === 'string'
            ? existing + '\n\n' + ephemeralContent
            : ephemeralContent;
          break;
        }
      }
    }

    return formatted;
  }

  /**
   * Format tools with frozen canonical serialization.
   * Tools are frozen after first serialization to guarantee byte-stable prefixes.
   */
  private formatToolsCacheAware(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    if (!this.frozenToolSpecs) {
      this.frozenToolSpecs = tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: this.extractSchemaParameters(tool.inputSchema),
        },
      }));
    }
    return this.frozenToolSpecs;
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
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), 'OpenAI Compatible API error', response);
      }

      const data = await response.json() as Record<string, unknown>;
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
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), 'OpenAI Compatible API error', response);
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
      // DeepSeek models
      'deepseek-v4-pro': { maxTokens: 131072 },
      'deepseek-v4-flash': { maxTokens: 131072 },
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
      case 'deepseek':
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
  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) {
      throw new Error('No choices in response');
    }

    const message = choice?.message as Record<string, unknown> | undefined;
    const content = (message?.content as string) || '';
    const toolCalls: ToolCall[] = [];

    // Parse tool calls
    const rawToolCalls = message?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls) {
        try {
          const fn = tc.function as Record<string, unknown> | undefined;
          toolCalls.push({
            id: tc.id as string,
            toolName: (fn?.name as string) || '',
            input: fn?.arguments ? JSON.parse(fn.arguments as string) : {},
            status: 'completed',
          });
        } catch (error) {
          console.warn('Failed to parse tool call arguments:', error);
        }
      }
    }

    // Parse usage
    const usageData = data.usage as Record<string, number> | undefined;
    const usage: TokenUsage = {
      inputTokens: usageData?.prompt_tokens || 0,
      outputTokens: usageData?.completion_tokens || 0,
      totalTokens: usageData?.total_tokens || 0,
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
          // Process any remaining buffer
          if (buffer.length > 0) {
            yield* this.processSSELine(buffer);
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines using indexOf to avoid array allocation
        let lineStart = 0;
        while (true) {
          const newlineIdx = buffer.indexOf('\n', lineStart);
          if (newlineIdx === -1) break;

          const line = buffer.slice(lineStart, newlineIdx);
          lineStart = newlineIdx + 1;

          if (line.length > 0) {
            yield* this.processSSELine(line);
          }
        }

        // Keep unprocessed remainder
        buffer = lineStart > 0 ? buffer.slice(lineStart) : buffer;
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Process a single SSE line - extracted for reuse from both normal and final buffer processing
   */
  private *processSSELine(line: string): Generator<LLMStreamEvent> {
    // Fast path: check for 'data: ' prefix without trim
    if (line.length < 6 || line.charCodeAt(0) !== 100) return; // 'd' = 100
    if (line.startsWith('data: ')) {
      const dataStr = line.slice(6);

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

  /**
   * Parse single stream chunk
   */
  private *parseStreamChunk(data: Record<string, unknown>): Generator<LLMStreamEvent> {
    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) {
      return;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;

    // Text delta
    if (delta?.content && choice.finish_reason !== 'tool_calls') {
      yield {
        type: 'text_delta',
        text: delta.content as string,
      };
    }

    // Tool calls
    const rawToolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls) {
        try {
          const fn = tc.function as Record<string, unknown> | undefined;
          const toolCall: ToolCall = {
            id: (tc.id as string) || `tool_call_${Date.now()}`,
            toolName: (fn?.name as string) || '',
            input: fn?.arguments ? JSON.parse(fn.arguments as string) : {},
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
      const usageData = data.usage as Record<string, number> | undefined;
      if (usageData) {
        yield {
          type: 'stop',
          usage: {
            inputTokens: usageData.prompt_tokens || 0,
            outputTokens: usageData.completion_tokens || 0,
            totalTokens: usageData.total_tokens || 0,
          },
        };
      }
    }
  }

  /**
   * Handle API errors with provider-specific handling
   */
  protected handleApiError(error: unknown, context: string, response?: Response): never {
    if (error instanceof Error) {
      const message = error.message;

      // Common error patterns
      if (message.includes('401') || message.includes('Unauthorized')) {
        throw new ApiError(`${context}: Invalid API key`, 401);
      }

      if (message.includes('429') || message.includes('rate limit')) {
        throw new ApiError(`${context}: Rate limit exceeded`, 429);
      }

      if (message.includes('403') || message.includes('Forbidden')) {
        throw new ApiError(`${context}: Access forbidden. Check API key permissions`, 403);
      }

      if (message.includes('model_not_found') || message.includes('invalid_model')) {
        throw new ApiError(`${context}: Model '${this.model}' not found`, 404);
      }
    }

    super.handleApiError(error, context, response);
  }
}
