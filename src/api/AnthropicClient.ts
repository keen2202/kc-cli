import { logger } from '../services/logger';
// Anthropic Claude API Client

import { BaseApiClient, ApiError } from './BaseApiClient';
import type { LLMStreamEvent, LLMRequestConfig, LLMResponse, TokenUsage } from './BaseApiClient';
import type { ChatMessage, ToolCall, ToolResult } from '../query/protocol';
import type { ToolDefinition } from '../tools/protocol';
import { getCapabilities } from './capabilities';

export interface AnthropicConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  apiVersion?: string;
}

export class AnthropicClient extends BaseApiClient {
  private apiVersion: string;
  private streamCacheUsage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null = null;

  constructor(config: AnthropicConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl || 'https://api.anthropic.com',
      model: config.model,
    });
    this.apiVersion = config.apiVersion || '2024-07-31';
  }

  /**
   * Send a chat completion request.
   * Transport + error pipeline delegated to BaseApiClient.withChatErrorHandling;
   * only payload building and response parsing are provider-specific here.
   */
  async chat(config: LLMRequestConfig): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new ApiError('Anthropic API key is required. Use /key to set.', 401);
    }
    return this.withChatErrorHandling(
      'Anthropic',
      {
        url: `${this.baseUrl}/v1/messages`,
        body: this.buildRequestBody({ ...config, stream: false }),
        signal: config.abortSignal,
      },
      data => this.parseResponse(data),
    );
  }

  /**
   * Stream chat completion response.
   * Transport + catch-yield-error-finally-cancel pipeline delegated to
   * BaseApiClient.withStreamErrorHandling; the SSE block parser remains
   * provider-specific.
   */
  async *streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent> {
    if (!this.apiKey) {
      throw new ApiError('Anthropic API key is required. Use /key to set.', 401);
    }

    yield* this.withStreamErrorHandling(
      'Anthropic',
      {
        url: `${this.baseUrl}/v1/messages`,
        body: this.buildRequestBody({ ...config, stream: true }),
        headers: { ...this.buildHeaders(), 'Accept': 'text/event-stream' },
        signal: config.abortSignal,
      },
      body => this.parseStreamResponse(body),
    );
  }

  /**
   * Validate API key format
   */
  validateApiKey(): boolean {
    // Anthropic keys start with "sk-ant-"
    return typeof this.apiKey === 'string' && this.apiKey.startsWith('sk-ant-');
  }

  /**
   * Get model information.
   * Reads from capabilities.ts (single source of truth, audit round3 T16) —
   * no local model table. `maxTokens` carries the per-model OUTPUT limit;
   * context capacity is exposed separately as maxContextWindow.
   */
  getModelInfo() {
    const caps = getCapabilities('anthropic', this.model);

    return {
      provider: 'anthropic',
      model: this.model,
      maxTokens: caps.maxOutputTokens,
      supportsStreaming: caps.supportsStreaming,
      supportsTools: caps.supportsToolUse,
    };
  }

  /**
   * Build request body for Anthropic API.
   * Ephemeral content is appended to the last user message to keep the cached prefix stable.
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
    // Pass ephemeral content to be appended to the last user message
    const messages = config.messages.filter(m => m.role !== 'system');
    if (messages.length > 0) {
      // T18/M4 boundary: the protocol module ships opaque structural mirrors;
      // this client's formatter works on the concrete conversation shapes that
      // the engine passed in (runtime-guaranteed by construction).
      body.messages = this.formatMessages(messages as ChatMessage[], config.ephemeralContent);
    }

    // Tools
    if (config.tools && config.tools.length > 0) {
      body.tools = this.formatTools(config.tools as ToolDefinition[]);
      body.tool_choice = { type: 'auto' };
    }

    if (config.temperature !== undefined) {
      body.temperature = config.temperature;
    }

    // Enable extended thinking when supported and opted-in
    const caps = getCapabilities('anthropic', this.model);
    if (caps.supportsExtendedThinking && process.env.KC_THINKING_ENABLED !== 'false') {
      const budgetTokens = parseInt(process.env.KC_THINKING_BUDGET_TOKENS || '10000', 10);
      body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
    }

    return body;
  }

  /**
   * Format messages for Anthropic API with cache optimization.
   * Places cache_control on the second-to-last user message to maximize prefix cache reuse.
   * Strategy: when messages.length >= MIN_MESSAGES_FOR_CACHE, mark the second-to-last user message
   * so that (system + tools + stable conversation history) is cached as a prefix.
   * The last user message (latest query) stays outside the cache boundary.
   * Ephemeral content (memory, level adaptation) is appended to the last user message.
   */
  protected formatMessages(messages: ChatMessage[], ephemeralContent?: string): Array<Record<string, unknown>> {
    const MIN_MESSAGES_FOR_CACHE = 4; // Only add breakpoint when conversation has enough context

    // Find the second-to-last user message index for cache breakpoint placement
    let lastUserIdx = -1;
    let secondToLastUserIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === 'user') {
        secondToLastUserIdx = lastUserIdx;
        lastUserIdx = i;
      }
    }

    const formatted = messages.map((msg, index) => {
      const contentArr: Array<Record<string, unknown>> = [];
      const formattedMsg: Record<string, unknown> = {
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: contentArr,
      };

      // Text content
      if (msg.content) {
        contentArr.push({
          type: 'text',
          text: msg.content,
        });
      }

      // Tool calls (assistant message)
      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        contentArr.push(...msg.toolCalls.map((tc: ToolCall) => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.toolName,
          input: tc.input,
        })));
      }

      // Ensure assistant messages always have content (some APIs require it)
      if (msg.role === 'assistant' && contentArr.length === 0) {
        contentArr.push({
          type: 'text',
          text: '(no response)',
        });
      }

      // Tool results (user message)
      if (msg.role === 'tool' && msg.toolResults && msg.toolResults.length > 0) {
        contentArr.push(...msg.toolResults.map((r: ToolResult) => ({
          type: 'tool_result',
          tool_use_id: r.toolCallId,
          content: r.output,
        })));
      }

      // Add cache breakpoint on the second-to-last user message when conversation is long enough.
      // This caches: system prompt + tools + conversation history (minus latest exchange).
      // If not enough messages or only one user message, fall back to first user message.
      const cacheTargetIdx = messages.length >= MIN_MESSAGES_FOR_CACHE && secondToLastUserIdx >= 0
        ? secondToLastUserIdx
        : (messages.length >= MIN_MESSAGES_FOR_CACHE ? 0 : -1);

      if (
        index === cacheTargetIdx &&
        msg.role === 'user' &&
        contentArr.length > 0
      ) {
        contentArr[contentArr.length - 1] = {
          ...contentArr[contentArr.length - 1],
          cache_control: { type: 'ephemeral' },
        };
      }

      return formattedMsg;
    });

    // Append ephemeral content to the last user message (outside cache boundary)
    if (ephemeralContent) {
      for (let i = formatted.length - 1; i >= 0; i--) {
        if (formatted[i].role === 'user') {
          const content = formatted[i].content as Array<Record<string, unknown>>;
          content.push({
            type: 'text',
            text: ephemeralContent,
          });
          break;
        }
      }
    }

    return formatted;
  }

  /**
   * Format tools for Anthropic API with cache optimization.
   * Places cache_control on the last tool to cache the entire tools array.
   * Tools are static across turns → high cache reuse.
   */
  protected formatTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
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
      'anthropic-beta': 'prompt-caching-2024-07-31',
    };
  }

  /**
   * Parse non-streaming response
   */
  private parseResponse(data: Record<string, unknown>): LLMResponse {
    const content = (data.content as Array<Record<string, unknown>>) || [];
    let textContent = '';
    const toolCalls: ToolCall[] = [];

    // Parse content blocks
    for (const block of content) {
      if (block.type === 'text') {
        textContent += block.text as string;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id as string,
          toolName: block.name as string,
          input: (block.input as Record<string, unknown>) || {},
          status: 'completed',
        });
      }
    }

    const usageData = data.usage as Record<string, number> | undefined;
    const usage: TokenUsage = {
      inputTokens: usageData?.input_tokens || 0,
      outputTokens: usageData?.output_tokens || 0,
      totalTokens: (usageData?.input_tokens || 0) + (usageData?.output_tokens || 0),
      cacheReadTokens: usageData?.cache_read_input_tokens || 0,
      cacheCreationTokens: usageData?.cache_creation_input_tokens || 0,
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
    // SSE state machine - context object created once, reused across all iterations
    const ctx = {
      currentEventType: null as string | null,
      currentToolCall: null as Partial<ToolCall> | null,
      toolInputBuffer: '',
      isThinking: false,
    };

    // Shared double-newline (SSE message) framing lives in
    // BaseApiClient.readStreamFrames; this parser only maps blocks to events.
    for await (const block of this.readStreamFrames(body, '\n\n')) {
      const trimmed = block.trim();
      if (!trimmed) continue;
      yield* this.processBufferLine(trimmed, ctx);
    }
  }

  /**
   * Process a single SSE message block
   */
  private *processBufferLine(
    block: string,
    ctx: {
      currentEventType: string | null;
      currentToolCall: Partial<ToolCall> | null;
      toolInputBuffer: string;
      isThinking: boolean;
    }
  ): Generator<LLMStreamEvent> {
    let eventType: string | null = null;
    let dataStr: string | null = null;

    // Parse event and data lines using indexOf to avoid split+trim overhead
    let pos = 0;
    const len = block.length;
    while (pos < len) {
      const lineEnd = block.indexOf('\n', pos);
      const actualEnd = lineEnd === -1 ? len : lineEnd;

      // Skip leading whitespace
      let lineStart = pos;
      while (lineStart < actualEnd && (block.charCodeAt(lineStart) === 32 || block.charCodeAt(lineStart) === 9)) {
        lineStart++;
      }

      if (actualEnd - lineStart >= 7 && block.charCodeAt(lineStart) === 101 && block.slice(lineStart, lineStart + 7) === 'event: ') {
        eventType = block.slice(lineStart + 7, actualEnd);
        ctx.currentEventType = eventType;
      } else if (actualEnd - lineStart >= 6 && block.charCodeAt(lineStart) === 100 && block.slice(lineStart, lineStart + 6) === 'data: ') {
        dataStr = block.slice(lineStart + 6, actualEnd);
      }

      pos = lineEnd === -1 ? len : lineEnd + 1;
    }

    // Must have both event type and data
    if (!eventType && !ctx.currentEventType) return;
    if (!dataStr) return;

    const resolvedEventType = eventType || ctx.currentEventType;

    try {
      const data = JSON.parse(dataStr);
      yield* this.parseStreamEvent(resolvedEventType!, data, ctx);
    } catch (error) {
      logger.api.warn('Failed to parse SSE event data: ' + String(error));
    }
  }

  /**
   * Parse single stream event.
   * Handles message_start (for cache metrics), content_block_start/delta/stop,
   * message_delta, message_stop, and error events.
   */
  private *parseStreamEvent(
    eventType: string,
    data: Record<string, unknown>,
    ctx: {
      currentToolCall: Partial<ToolCall> | null;
      toolInputBuffer: string;
      isThinking: boolean;
    }
  ): Generator<LLMStreamEvent> {
    switch (eventType) {
      case 'message_start': {
        const message = data.message as Record<string, unknown> | undefined;
        const msgUsage = message?.usage as Record<string, number> | undefined;
        if (msgUsage) {
          this.streamCacheUsage = {
            inputTokens: msgUsage.input_tokens || 0,
            outputTokens: msgUsage.output_tokens || 0,
            cacheReadTokens: msgUsage.cache_read_input_tokens || 0,
            cacheCreationTokens: msgUsage.cache_creation_input_tokens || 0,
          };
        }
        break;
      }

      case 'content_block_start': {
        const contentBlock = data.content_block as Record<string, unknown> | undefined;
        if (contentBlock?.type === 'tool_use') {
          ctx.currentToolCall = {
            id: contentBlock.id as string,
            toolName: contentBlock.name as string,
            input: {},
          };
          ctx.toolInputBuffer = '';
        } else if (contentBlock?.type === 'thinking') {
          ctx.isThinking = true;
        }
        break;
      }

      case 'content_block_delta': {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') {
          yield {
            type: 'text_delta',
            text: delta.text as string,
          };
        } else if (delta?.type === 'thinking_delta') {
          yield {
            type: 'thinking_delta',
            thinking: delta.thinking as string,
          };
        } else if (delta?.type === 'input_json_delta') {
          ctx.toolInputBuffer += ((delta.partial_json as string) || '');
        }
        break;
      }

      case 'content_block_stop':
        if (ctx.isThinking) {
          ctx.isThinking = false;
        } else if (ctx.currentToolCall) {
          try {
            const toolCall: ToolCall = {
              id: ctx.currentToolCall.id || '',
              toolName: ctx.currentToolCall.toolName || '',
              input: ctx.toolInputBuffer ? JSON.parse(ctx.toolInputBuffer) : {},
              status: 'completed',
            };

            yield {
              type: 'tool_use',
              toolCall,
            };

            ctx.currentToolCall = null;
            ctx.toolInputBuffer = '';
          } catch (error) {
            logger.api.warn('Failed to parse tool input: ' + String(error));
          }
        }
        break;

      case 'message_stop':
        if (this.streamCacheUsage) {
          yield {
            type: 'stop',
            usage: {
              inputTokens: this.streamCacheUsage.inputTokens,
              outputTokens: this.streamCacheUsage.outputTokens,
              totalTokens: this.streamCacheUsage.inputTokens + this.streamCacheUsage.outputTokens,
              cacheReadTokens: this.streamCacheUsage.cacheReadTokens,
              cacheCreationTokens: this.streamCacheUsage.cacheCreationTokens,
            },
          };
          this.streamCacheUsage = null;
        } else {
          yield { type: 'stop' };
        }
        break;

      case 'message_delta': {
        const deltaUsage = data.usage as Record<string, number> | undefined;
        if (deltaUsage?.output_tokens && this.streamCacheUsage) {
          this.streamCacheUsage.outputTokens += deltaUsage.output_tokens;
        }
        break;
      }

      case 'error': {
        const errorData = data.error as Record<string, unknown> | undefined;
        yield {
          type: 'error',
          error: new Error((errorData?.message as string) || 'Unknown Anthropic error'),
        };
        break;
      }
    }
  }

  /**
   * M8: Anthropic-specific classification sits ahead of the shared rules —
   * the shared table now covers 401/429 (`rate_limit` included), 403 and 404.
   */
  protected errorRules(): Array<{ match: RegExp | string[]; status?: number; message: string }> {
    return [
      {
        match: /overloaded_error/,
        status: 529,
        message: 'Anthropic API is currently overloaded, please try again',
      },
      ...super.errorRules(),
    ];
  }
}
