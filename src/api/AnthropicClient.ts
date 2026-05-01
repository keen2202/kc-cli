// Anthropic Claude API Client

import { BaseApiClient } from './BaseApiClient';
import type { LLMStreamEvent, LLMRequestConfig, LLMResponse, TokenUsage } from './BaseApiClient';
import type { ToolCall } from '../types/message';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  apiVersion?: string;
}

export class AnthropicClient extends BaseApiClient {
  private apiVersion: string;

  constructor(config: AnthropicConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.anthropic.com',
      model: config.model,
    });
    this.apiVersion = config.apiVersion || '2023-06-01';
  }

  /**
   * Send a chat completion request
   */
  async chat(config: LLMRequestConfig): Promise<LLMResponse> {
    const requestBody = this.buildRequestBody({ ...config, stream: false });
    const headers = this.buildHeaders();

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: config.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), 'Anthropic API error');
      }

      const data = await response.json();
      return this.parseResponse(data);
    } catch (error) {
      this.handleApiError(error, 'Failed to call Anthropic API');
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

    try {
      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: config.abortSignal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), 'Anthropic API error');
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
    // Anthropic keys start with "sk-ant-"
    return typeof this.apiKey === 'string' && this.apiKey.startsWith('sk-ant-');
  }

  /**
   * Get model information
   */
  getModelInfo() {
    const modelInfo: Record<string, { maxTokens: number }> = {
      'claude-3-5-sonnet-20241022': { maxTokens: 8192 },
      'claude-3-5-haiku-20241022': { maxTokens: 8192 },
      'claude-3-opus-20240229': { maxTokens: 4096 },
      'claude-3-sonnet-20240229': { maxTokens: 4096 },
      'claude-3-haiku-20240307': { maxTokens: 4096 },
      'claude-sonnet-4-20250514': { maxTokens: 8192 },
    };

    const info = modelInfo[this.model] || { maxTokens: 8192 };

    return {
      provider: 'anthropic',
      model: this.model,
      maxTokens: info.maxTokens,
      supportsStreaming: true,
      supportsTools: true,
    };
  }

  /**
   * Build request body for Anthropic API
   */
  protected buildRequestBody(config: LLMRequestConfig): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: config.maxTokens || 4096,
      stream: config.stream ?? true,
    };

    if (config.systemPrompt) {
      body.system = [{
        type: 'text',
        text: config.systemPrompt,
        cache_control: { type: 'ephemeral' },
      }];
    }

    // Format messages (filter out system messages)
    const messages = config.messages.filter(m => m.role !== 'system');
    if (messages.length > 0) {
      body.messages = this.formatMessages(messages);
    }

    // Tools
    if (config.tools && config.tools.length > 0) {
      body.tools = this.formatTools(config.tools);
      body.tool_choice = { type: 'auto' };
    }

    if (config.temperature !== undefined) {
      body.temperature = config.temperature;
    }

    return body;
  }

  /**
   * Format messages for Anthropic API
   */
  protected formatMessages(messages: any[]): Array<Record<string, unknown>> {
    return messages.map(msg => {
      const formatted: Record<string, unknown> = {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: [],
      };

      // Text content
      if (msg.content) {
        (formatted.content as any[]).push({
          type: 'text',
          text: msg.content,
        });
      }

      // Tool calls (assistant message)
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        (formatted.content as any[]).push(...msg.toolCalls.map((tc: ToolCall) => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.toolName,
          input: tc.input,
        })));
      }

      // Tool results (user message)
      if (msg.role === 'tool' && msg.toolResults && msg.toolResults.length > 0) {
        (formatted.content as any[]).push(...msg.toolResults.map((r: any) => ({
          type: 'tool_result',
          tool_use_id: r.toolCallId,
          content: r.output,
        })));
      }

      return formatted;
    });
  }

  /**
   * Format tools for Anthropic API
   */
  protected formatTools(tools: any[]): Array<Record<string, unknown>> {
    return tools.map((tool, index) => ({
      name: tool.name,
      description: tool.description,
      input_schema: this.extractSchemaParameters(tool.inputSchema),
      ...(index === tools.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}),
    }));
  }

  /**
   * Build request headers for Anthropic API
   */
  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion,
    };
  }

  /**
   * Parse non-streaming response
   */
  private parseResponse(data: any): LLMResponse {
    const content = data.content || [];
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    // Parse content blocks
    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          toolName: block.name,
          input: block.input || {},
          status: 'completed',
        });
      }
    }

    const usage: TokenUsage = {
      inputTokens: data.usage?.input_tokens || 0,
      outputTokens: data.usage?.output_tokens || 0,
      totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
      cacheReadTokens: data.usage?.cache_read_input_tokens || 0,
      cacheCreationTokens: data.usage?.cache_creation_input_tokens || 0,
    };

    return {
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
    };
  }

  /**
   * Parse streaming response with stateful SSE accumulator
   * Handles arbitrary chunk boundaries properly
   */
  private async *parseStreamResponse(body: ReadableStream): AsyncGenerator<LLMStreamEvent> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // SSE state machine
    let currentEventType: string | null = null;
    let currentToolCall: Partial<ToolCall> | null = null;
    let toolInputBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Process remaining buffer
          if (buffer.trim()) {
            yield* this.processBufferLine(buffer.trim(), {
              currentEventType: currentEventType,
              currentToolCall,
              toolInputBuffer,
              setEventType: (type) => { currentEventType = type; },
              setToolCall: (tc) => { currentToolCall = tc; },
              setToolInputBuffer: (buf) => { toolInputBuffer = buf; },
            });
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Split by double newline (SSE message separator)
        const parts = buffer.split('\n\n');
        // Keep last incomplete part in buffer
        buffer = parts.pop() || '';

        // Process complete messages
        for (const part of parts) {
          const trimmed = part.trim();
          if (!trimmed) continue;
          
          yield* this.processBufferLine(trimmed, {
            currentEventType: currentEventType,
            currentToolCall,
            toolInputBuffer,
            setEventType: (type) => { currentEventType = type; },
            setToolCall: (tc) => { currentToolCall = tc; },
            setToolInputBuffer: (buf) => { toolInputBuffer = buf; },
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Process a single SSE message block
   */
  private *processBufferLine(
    block: string,
    context: {
      currentEventType: string | null;
      currentToolCall: Partial<ToolCall> | null;
      toolInputBuffer: string;
      setEventType: (type: string) => void;
      setToolCall: (tc: Partial<ToolCall>) => void;
      setToolInputBuffer: (buf: string) => void;
    }
  ): Generator<LLMStreamEvent> {
    const lines = block.split('\n');
    let eventType: string | null = null;
    let dataStr: string | null = null;

    // Parse event type and data from the block
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('event: ')) {
        eventType = trimmed.slice(7);
        context.setEventType(eventType);
      } else if (trimmed.startsWith('data: ')) {
        dataStr = trimmed.slice(6);
      }
    }

    // Must have both event type and data
    if (!eventType && !context.currentEventType) return;
    if (!dataStr) return;

    const resolvedEventType = eventType || context.currentEventType;

    try {
      const data = JSON.parse(dataStr);
      yield* this.parseStreamEvent(resolvedEventType!, data, {
        currentToolCall: context.currentToolCall,
        toolInputBuffer: context.toolInputBuffer,
        setToolCall: context.setToolCall,
        setToolInputBuffer: context.setToolInputBuffer,
      });
    } catch (error) {
      console.warn('Failed to parse SSE event data:', error);
    }
  }

  /**
   * Parse single stream event
   */
  private *parseStreamEvent(
    eventType: string,
    data: any,
    context: {
      currentToolCall: Partial<ToolCall> | null;
      toolInputBuffer: string;
      setToolCall: (tc: Partial<ToolCall>) => void;
      setToolInputBuffer: (buf: string) => void;
    }
  ): Generator<LLMStreamEvent> {
    switch (eventType) {
      case 'content_block_start':
        if (data.content_block?.type === 'text') {
          // Text block starting
        } else if (data.content_block?.type === 'tool_use') {
          context.setToolCall({
            id: data.content_block.id,
            toolName: data.content_block.name,
            input: {},
          });
          context.setToolInputBuffer('');
        }
        break;

      case 'content_block_delta':
        if (data.delta?.type === 'text_delta') {
          yield {
            type: 'text_delta',
            text: data.delta.text,
          };
        } else if (data.delta?.type === 'input_json_delta') {
          // Accumulate tool input
          context.setToolInputBuffer(context.toolInputBuffer + (data.delta.partial_json || ''));
        }
        break;

      case 'content_block_stop':
        // Tool call complete
        if (context.currentToolCall) {
          try {
            const toolCall: ToolCall = {
              id: context.currentToolCall.id || '',
              toolName: context.currentToolCall.toolName || '',
              input: context.toolInputBuffer ? JSON.parse(context.toolInputBuffer) : {},
              status: 'completed',
            };

            yield {
              type: 'tool_use',
              toolCall,
            };

            context.setToolCall(null);
            context.setToolInputBuffer('');
          } catch (error) {
            console.warn('Failed to parse tool input:', error);
          }
        }
        break;

      case 'message_stop':
        yield { type: 'stop' };
        break;

      case 'message_delta':
        if (data.usage) {
          yield {
            type: 'stop',
            usage: {
              inputTokens: data.usage?.input_tokens || 0,
              outputTokens: data.usage?.output_tokens || 0,
              totalTokens: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
            },
          };
        }
        break;

      case 'error':
        yield {
          type: 'error',
          error: new Error(data.error?.message || 'Unknown Anthropic error'),
        };
        break;
    }
  }

  /**
   * Handle API errors with Anthropic-specific handling
   */
  protected handleApiError(error: unknown, context: string): never {
    if (error instanceof Error) {
      const message = error.message;

      if (message.includes('401') || message.includes('invalid_api_key')) {
        throw new Error(`${context}: Invalid API key`);
      }

      if (message.includes('429') || message.includes('rate_limit')) {
        throw new Error(`${context}: Rate limit exceeded`);
      }

      if (message.includes('overloaded_error')) {
        throw new Error(`${context}: Anthropic API is currently overloaded, please try again`);
      }
    }

    super.handleApiError(error, context);
  }
}
