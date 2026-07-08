// Base API Client - Abstract interface for LLM providers

import type { ChatMessage, ToolCall } from '../query/protocol';
import type { ToolDefinition } from '../tools/protocol';
import type { LLMStreamEvent, LLMRequestConfig, LLMResponse } from './protocol';
import { ApiError } from './protocol';
import { z } from 'zod';
import { zodToJsonSchema } from '../utils/zodToJsonSchema';

// Re-export protocol types for backward compatibility
export type { LLMStreamEvent, TokenUsage, LLMRequestConfig, LLMResponse } from './protocol';
export { ApiError } from './protocol';

/**
 * Abstract base class for all LLM API clients.
 * Provides a unified interface for streaming and non-streaming responses.
 */
export abstract class BaseApiClient {
  protected apiKey: string;
  protected baseUrl: string;
  protected model: string;

  // ── Formatted-message cache (appends-only) ──────────────────────────
  // Caches individual message formatting by message id.
  // A single ChatMessage can produce multiple output entries (e.g. tool results),
  // so each entry is an array.
  private _msgFormatCache = new Map<string, Array<Record<string, unknown>>>();

  // Full-array cache for reference equality on repeated calls with the same messages.
  // Key: concatenation of message ids.
  private _msgFullCache: { ids: string; result: Array<Record<string, unknown>> } | null = null;

  // ── Formatted-tools cache ───────────────────────────────────────────
  // Composite key: tool name + JSON of the input schema.
  private _toolsFormatCache: { key: string; result: Array<Record<string, unknown>> } | null = null;

  constructor(config: { apiKey: string; baseUrl: string; model: string }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
  }

  /**
   * Send a chat completion request (non-streaming)
   */
  abstract chat(config: LLMRequestConfig): Promise<LLMResponse>;

  /**
   * Stream chat completion response
   * Returns async generator of LLMStreamEvent
   */
  abstract streamChat(config: LLMRequestConfig): AsyncGenerator<LLMStreamEvent>;

  /**
   * Validate API key format
   */
  abstract validateApiKey(): boolean;

  /**
   * Get model information
   */
  abstract getModelInfo(): {
    provider: string;
    model: string;
    maxTokens: number;
    supportsStreaming: boolean;
    supportsTools: boolean;
  };

  /**
   * Build request body for API call
   * Subclasses can override for provider-specific formatting
   */
  protected buildRequestBody(config: LLMRequestConfig): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.formatMessages(config.messages),
      stream: config.stream ?? true,
    };

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
      body.tools = this.formatTools(config.tools);
    }

    return body;
  }

  /**
   * Format messages for API request
   * Subclasses can override for provider-specific formatting.
   * Messages are cached by their `id` so that appending new messages to
   * a conversation only re-formats the new/changed entries.
   */
  protected formatMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    // Full-array cache hit: same set of messages (ids) as last call
    const idsKey = messages.map(m => m.id).join('\x00');
    if (this._msgFullCache && this._msgFullCache.ids === idsKey) {
      return this._msgFullCache.result;
    }

    const result: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      // Per-message cache hit: individual entry already formatted
      const cached = this._msgFormatCache.get(msg.id);
      if (cached) {
        result.push(...cached);
        continue;
      }

      const entries: Array<Record<string, unknown>> = [];

      if (msg.role === 'tool') {
        // Pre-formatted tool message (from buildApiMessages) - pass through
        const toolMsg = msg as ChatMessage & { tool_call_id?: string };
        if (toolMsg.tool_call_id) {
          entries.push({
            role: 'tool',
            tool_call_id: toolMsg.tool_call_id,
            content: msg.content ?? '',
          });
          this._msgFormatCache.set(msg.id, entries);
          result.push(...entries);
          continue;
        }
        // ChatMessage with toolResults - expand each result
        if (msg.toolResults && msg.toolResults.length > 0) {
          for (const tr of msg.toolResults) {
            entries.push({
              role: 'tool',
              tool_call_id: tr.toolCallId,
              content: tr.output ?? '',
            });
          }
          this._msgFormatCache.set(msg.id, entries);
          result.push(...entries);
          continue;
        }
      }

      const formatted: Record<string, unknown> = {
        role: msg.role,
        content: msg.content ?? '',
      };

      // Pre-formatted assistant message (from buildApiMessages) - preserve tool_calls
      const asstMsg = msg as ChatMessage & { tool_calls?: unknown };
      if (msg.role === 'assistant' && asstMsg.tool_calls) {
        // Validate pre-formatted tool_calls: filter out entries with missing function name
        const rawToolCalls = asstMsg.tool_calls as Array<Record<string, unknown>>;
        if (Array.isArray(rawToolCalls)) {
          const validRaw = rawToolCalls.filter(tc => {
            const fn = tc.function as Record<string, unknown> | undefined;
            return fn?.name && typeof fn.name === 'string' && fn.name.trim().length > 0;
          });
          if (validRaw.length > 0) {
            formatted.tool_calls = validRaw;
          }
        } else {
          formatted.tool_calls = asstMsg.tool_calls;
        }
      } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        const validToolCalls = msg.toolCalls
          .filter(tc => tc.toolName && tc.toolName.trim().length > 0)
          .map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.input),
            },
          }));
        if (validToolCalls.length > 0) {
          formatted.tool_calls = validToolCalls;
        }
      }

      // Ensure assistant messages always have content (some APIs require it)
      if (msg.role === 'assistant' && !formatted.content && !formatted.tool_calls) {
        formatted.content = '(no response)';
      }

      entries.push(formatted);
      this._msgFormatCache.set(msg.id, entries);
      result.push(...entries);
    }

    // Cache the full result array for reference equality on next call
    this._msgFullCache = { ids: idsKey, result };
    return result;
  }

  /**
   * Format tools for API request
   * Subclasses can override for provider-specific formatting.
   * Caches the result keyed by tool names + schema JSON so that
   * repeated calls with the same tool set return the cached array.
   */
  protected formatTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    // Build composite key: tool name + JSON of schema
    const key = tools.map(t => {
      let schemaStr: string;
      try {
        schemaStr = JSON.stringify(t.inputSchema);
      } catch {
        schemaStr = '<unserializable>';
      }
      return `${t.name}:${schemaStr}`;
    }).join('||');

    if (this._toolsFormatCache && this._toolsFormatCache.key === key) {
      return this._toolsFormatCache.result;
    }

    const result = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.extractSchemaParameters(tool.inputSchema),
      },
    }));

    this._toolsFormatCache = { key, result };
    return result;
  }

  /**
   * Extract parameters from Zod schema for tool definition
   * Converts Zod schema to JSON Schema format for LLM tool definitions
   */
  protected extractSchemaParameters(schema: unknown): Record<string, unknown> {
    if (!schema) {
      return { type: 'object', properties: {} };
    }

    // If it's already a plain object (JSON Schema), return as-is
    if (typeof schema === 'object' && schema !== null && !('_def' in schema)) {
      const obj = schema as Record<string, unknown>;
      // If it has a type field, assume it's valid JSON Schema
      if ('type' in obj) return obj;
      // Otherwise wrap as object schema
      return { type: 'object', properties: obj, required: [] };
    }

    // Convert Zod schema to JSON Schema
    try {
      return zodToJsonSchema(schema as z.ZodType);
    } catch {
      // Fallback for unsupported schema types
      return { type: 'object', properties: {} };
    }
  }

  /**
   * Build request headers
   * Subclasses can override for provider-specific headers
   */
  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  /**
   * Handle API errors
   * When a Response is provided, extracts status code and headers into ApiError.
   * Subclasses can override for provider-specific error handling.
   */
  protected handleApiError(error: unknown, context: string, response?: Response): never {
    const headers: Record<string, string> = {};
    let statusCode: number | undefined;

    if (response) {
      statusCode = response.status;
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }

    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(`${context}: ${message}`, statusCode, headers);
  }
}
