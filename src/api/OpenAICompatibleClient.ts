import { logger } from '../services/logger';
// OpenAI Compatible API Client
// Supports: OpenAI (GPT), Qwen (DashScope), GLM (Zhipu AI), and other OpenAI-compatible APIs
// Cache optimization: byte-stable serialization for DeepSeek auto-prefix caching

import { BaseApiClient, ApiError } from './BaseApiClient';
import type { LLMStreamEvent, LLMRequestConfig, LLMResponse, TokenUsage } from './BaseApiClient';
import type { ChatMessage, ToolCall } from '../query/protocol';
import type { ToolDefinition } from '../tools/protocol';
import { canonicalStringify } from '../services/cachePrefix';
import { ThinkingTagParser } from './ThinkingTagParser';
import { getCapabilities } from './capabilities';

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  provider?: 'openai' | 'qwen' | 'glm' | 'deepseek' | 'mimo' | 'kimi' | 'step' | 'gemini';
}

export class OpenAICompatibleClient extends BaseApiClient {
  private provider: 'openai' | 'qwen' | 'glm' | 'deepseek' | 'mimo' | 'kimi' | 'step' | 'gemini';
  private frozenToolSpecs: Array<Record<string, unknown>> | null = null;
  // Buffer to accumulate incremental tool call arguments across stream chunks
  private toolCallBuffer: Map<number, { id: string; name: string; args: string }> = new Map();
  // Parser for <thinking> tags in text streams (for chain-of-thought providers)
  private thinkingParser = new ThinkingTagParser();
  // Usage reported by the final stream chunk (stream_options.include_usage);
  // attached to the 'stop' event so the engine can surface real token counts.
  private streamUsage: TokenUsage | null = null;

  constructor(config: OpenAICompatibleConfig) {
    super({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      model: config.model,
    });
    this.provider = config.provider || 'openai';
  }

  /**
   * Build full API URL, normalizing to avoid double path segments (e.g. /v1/v1/...)
   */
  private buildUrl(endpoint: string): string {
    const base = this.baseUrl.replace(/\/+$/, '');
    // If baseUrl already ends with the endpoint's version prefix (e.g. /v1), strip it
    // to avoid doubling when endpoint also starts with /v1/...
    const versionMatch = endpoint.match(/^(\/v\d+[a-z]*)\//);
    if (versionMatch && base.endsWith(versionMatch[1])) {
      return `${base}${endpoint.slice(versionMatch[1].length)}`;
    }
    return `${base}${endpoint}`;
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
      // T18/M4 boundary: reclaim the concrete shapes (see protocol-decoupling test).
      messages: this.formatMessagesCacheAware(config.messages as ChatMessage[], config.ephemeralContent),
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
      body.tools = this.formatToolsCacheAware(config.tools as ToolDefinition[]);
    }

    // OpenAI: enable prompt caching for supported models
    if (this.provider === 'openai') {
      body.prompt_cache = true;
    }

    // Streaming: ask the API to append a final usage chunk so token counts
    // are real, not zeros. Gateways that don't support it ignore the field.
    if (body.stream === true) {
      body.stream_options = { include_usage: true };
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
   * Send a chat completion request.
   * Transport + error pipeline delegated to BaseApiClient.withChatErrorHandling;
   * only payload building and response parsing are provider-specific here.
   */
  async chat(config: LLMRequestConfig): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new ApiError(`${this.provider} API key is required. Use /key to set.`, 401);
    }
    return this.withChatErrorHandling(
      'OpenAI Compatible',
      {
        url: this.buildUrl(this.getEndpoint()),
        body: this.buildRequestBody({ ...config, stream: false }),
        signal: config.abortSignal,
      },
      data => this.parseResponse(data),
    );
  }

  /**
   * Stream chat completion response.
   * Transport + catch-yield-error-finally-cancel pipeline delegated to
   * BaseApiClient.withStreamErrorHandling; buffer resets and the SSE frame
   * parser remain provider-specific.
   */
  async *streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent> {
    if (!this.apiKey) {
      throw new ApiError(`${this.provider} API key is required. Use /key to set.`, 401);
    }
    // Clear tool call buffer from any previous stream
    this.toolCallBuffer.clear();
    this.thinkingParser.reset();
    this.streamUsage = null;

    yield* this.withStreamErrorHandling(
      'OpenAI Compatible',
      {
        url: this.buildUrl(this.getEndpoint()),
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
    // OpenAI, Qwen, GLM all use Bearer token format
    // Basic validation: non-empty string
    return typeof this.apiKey === 'string' && this.apiKey.length > 0;
  }

  /**
   * Get model information.
   * Reads from capabilities.ts (single source of truth, audit round3 T16) —
   * no local model table; the lookup is scoped to this.provider. `maxTokens`
   * carries the model CONTEXT WINDOW (matching the previous table's semantics).
   */
  getModelInfo() {
    const caps = getCapabilities(this.provider, this.model);

    return {
      provider: this.provider,
      model: this.model,
      maxTokens: caps.maxContextWindow,
      supportsStreaming: caps.supportsStreaming,
      supportsTools: caps.supportsToolUse,
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
      case 'gemini':
        // Google Gemini OpenAI-compatible endpoint
        return '/v1beta/openai/chat/completions';
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
          const name = (fn?.name as string) || '';
          if (!name) {
            logger.api.warn('Skipping tool call with missing function name');
            continue;
          }
          toolCalls.push({
            id: tc.id as string,
            toolName: name,
            input: fn?.arguments ? JSON.parse(fn.arguments as string) : {},
            status: 'completed',
          });
        } catch (error) {
          logger.api.warn('Failed to parse tool call arguments: ' + String(error));
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
    // Shared newline framing lives in BaseApiClient.readStreamFrames;
    // this parser only maps SSE lines to LLM stream events.
    for await (const line of this.readStreamFrames(body, '\n')) {
      yield* this.processSSELine(line);
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
        // Attach the usage captured from the final chunk (if the API sent one)
        // so downstream turn_complete events carry real token counts.
        yield this.streamUsage ? { type: 'stop', usage: this.streamUsage } : { type: 'stop' };
        return;
      }

      try {
        const data = JSON.parse(dataStr);
        yield* this.parseStreamChunk(data);
      } catch (error) {
        logger.api.warn('Failed to parse SSE chunk: ' + String(error));
      }
    }
  }

  /**
   * Parse single stream chunk
   */
  private *parseStreamChunk(data: Record<string, unknown>): Generator<LLMStreamEvent> {
    // Usage arrives in a trailing chunk with an empty choices array when
    // stream_options.include_usage is set — capture it before the choice guard.
    const usageData = data.usage as Record<string, number> | null | undefined;
    if (usageData) {
      this.streamUsage = {
        inputTokens: usageData.prompt_tokens || 0,
        outputTokens: usageData.completion_tokens || 0,
        totalTokens: usageData.total_tokens
          || (usageData.prompt_tokens || 0) + (usageData.completion_tokens || 0),
      };
    }

    const choices = data.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) {
      return;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;

    // Reasoning stream (DeepSeek-R1 / QwQ / GLM style): a dedicated delta
    // field, independent of the <thinking>-tag protocol. Surface it as
    // thinking_delta so the UI can show live progress during long reasoning.
    if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      yield {
        type: 'thinking_delta',
        thinking: delta.reasoning_content,
      };
    }

    // Text delta — pass through thinking tag parser for chain-of-thought providers
    if (delta?.content && choice.finish_reason !== 'tool_calls') {
      const caps = getCapabilities(this.provider, this.model);
      if (caps.supportsChainOfThought) {
        for (const event of this.thinkingParser.process(delta.content as string)) {
          yield {
            type: event.type === 'thinking_delta' ? 'thinking_delta' : 'text_delta',
            ...(event.type === 'thinking_delta'
              ? { thinking: event.content }
              : { text: event.content }),
          };
        }
      } else {
        yield {
          type: 'text_delta',
          text: delta.content as string,
        };
      }
    }

    // Tool calls - accumulate incremental argument chunks
    const rawToolCalls = delta?.tool_calls as Array<Record<string, unknown>> | undefined;
    if (rawToolCalls && Array.isArray(rawToolCalls)) {
      for (const tc of rawToolCalls) {
        const index = (tc.index as number) ?? 0;
        const fn = tc.function as Record<string, unknown> | undefined;

        // Get or create buffer entry for this tool call index
        let entry = this.toolCallBuffer.get(index);
        if (!entry) {
          entry = { id: '', name: '', args: '' };
          this.toolCallBuffer.set(index, entry);
        }

        // Accumulate fields (id and name come in first chunk, args stream incrementally)
        if (tc.id) entry.id = tc.id as string;
        if (fn?.name) entry.name = fn.name as string;
        if (fn?.arguments) entry.args += fn.arguments as string;
      }
    }

    // When finish_reason signals tool_calls or stop, flush the accumulated buffer
    if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
      yield* this.flushToolCallBuffer();
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
   * Flush accumulated tool call buffer and yield complete tool calls
   */
  private *flushToolCallBuffer(): Generator<LLMStreamEvent> {
    for (const [, entry] of this.toolCallBuffer) {
      if (!entry.name) {
        logger.api.warn('Skipping streamed tool call with missing function name');
        continue;
      }
      try {
        const input = entry.args ? JSON.parse(entry.args) : {};
        const toolCall: ToolCall = {
          id: entry.id || `tool_call_${Date.now()}`,
          toolName: entry.name,
          input,
          status: 'completed',
        };
        yield { type: 'tool_use', toolCall };
      } catch (error) {
        logger.api.warn('Failed to parse accumulated tool call arguments: ' + String(error));
      }
    }
    this.toolCallBuffer.clear();
  }

  // M8: the previous local 401/429/403/404 ladder is replaced by the shared
  // rule table in BaseApiClient.errorRules() — no provider-specific rules.
}
