// Base API Client - Abstract interface for LLM providers

import type { ChatMessage, ToolCall } from '../query/protocol';
import type { ToolDefinition } from '../tools/protocol';
import type { LLMStreamEvent, LLMRequestConfig, LLMResponse } from './protocol';
import { ApiError } from './protocol';
import { z } from 'zod';
import { zodToJsonSchema } from '../utils/zodToJsonSchema';
import { logger } from '../services/logger';
import { redactTruncated } from '../utils/redact';

// Re-export protocol types for backward compatibility
export type { LLMStreamEvent, TokenUsage, LLMRequestConfig, LLMResponse } from './protocol';
export { ApiError } from './protocol';

/**
 * Per-request transport details that differ between providers.
 * Everything else about the chat/stream pipelines (fetch → !ok →
 * handleApiError → parse, catch-yield-finally-cancel) is identical across
 * clients and lives in the two template methods below.
 */
export interface ApiRequestInit {
  url: string;
  body: Record<string, unknown>;
  /** Defaults to buildHeaders() when omitted (Ollama sends bare headers). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * Abstract base class for all LLM API clients.
 * Provides a unified interface for streaming and non-streaming responses.
 */
export abstract class BaseApiClient {
  protected apiKey: string;
  protected baseUrl: string;
  protected model: string;

  // ── Formatted-message cache (appends-only) ──────────────────────────
  // Caches individual message formatting by message id + content hash.
  // A single ChatMessage can produce multiple output entries (e.g. tool results),
  // so each entry is an array.
  private _msgFormatCache = new Map<string, Array<Record<string, unknown>>>();

  // Full-array cache for reference equality on repeated calls with the same messages.
  // Key: concatenation of "(msg.id):(contentHash)" entries.
  private _msgFullCache: { ids: string; result: Array<Record<string, unknown>> } | null = null;

  // ── Formatted-tools cache ───────────────────────────────────────────
  // Composite key: tool name + JSON of the input schema.
  private _toolsFormatCache: { key: string; result: Array<Record<string, unknown>> } | null = null;

  /**
   * Compute a simple content hash for a ChatMessage.
   * Used in cache keys to detect content changes that preserve the same msg.id.
   */
  private static hashContent(msg: ChatMessage): string {
    // Serialize only the parts that affect formatting output
    const payload = {
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolResults: msg.toolResults,
      tool_call_id: (msg as unknown as Record<string, unknown>).tool_call_id,
      tool_calls: (msg as unknown as Record<string, unknown>).tool_calls,
    };
    let str: string;
    try {
      str = JSON.stringify(payload);
    } catch {
      str = `${msg.role}:${msg.content ?? ''}`;
    }
    // djb2 hash — fast, decent distribution, no deps
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash |= 0; // force 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

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
      // T18/M4 boundary: the protocol module ships opaque structural mirrors;
      // this client's formatter works on the concrete conversation shapes that
      // the engine passed in (runtime-guaranteed by construction).
      messages: this.formatMessages(config.messages as ChatMessage[]),
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
      body.tools = this.formatTools(config.tools as ToolDefinition[]);
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
    // Full-array cache hit: same set of messages (ids + content hashes) as last call.
    // Skip cache when any message lacks an id (undefined ids collide).
    const allHaveIds = messages.every(m => m.id !== undefined);
    const idsKey = allHaveIds
      ? messages.map(m => `${m.id!}:${BaseApiClient.hashContent(m)}`).join('\x00')
      : null;
    if (idsKey && this._msgFullCache && this._msgFullCache.ids === idsKey) {
      return this._msgFullCache.result;
    }

    const result: Array<Record<string, unknown>> = [];

    for (const msg of messages) {
      // Per-message cache hit: individual entry already formatted.
      // Key is msg.id + content hash so that content changes invalidate the entry
      // even when the id stays the same.
      const msgKey = msg.id !== undefined ? `${msg.id}:${BaseApiClient.hashContent(msg)}` : undefined;
      const cached = msgKey !== undefined ? this._msgFormatCache.get(msgKey) : undefined;
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
          if (msgKey !== undefined) this._msgFormatCache.set(msgKey, entries);
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
          if (msgKey !== undefined) this._msgFormatCache.set(msgKey, entries);
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
      if (msgKey !== undefined) this._msgFormatCache.set(msgKey, entries);
      result.push(...entries);
    }

    // Cache the full result array for reference equality on next call
    if (idsKey !== null) this._msgFullCache = { ids: idsKey, result };
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
   * Handle API errors — rule-table driven (M8, round4 §6-M8).
   *
   * The provider clients previously carried three divergent copies of the same
   * classification ladder (Anthropic matched `rate_limit` but missed 403/404;
   * OpenAI matched `rate limit` and had no `overloaded_error`). Every failure
   * now flows through this single implementation:
   *   1. `errorRules()` — common classification + subclass extras, first match wins.
   *   2. Fallback — redacted, length-capped generic wrap.
   *
   * Rule semantics: `match: RegExp` → OR-style test on the error message;
   * `match: string[]` → ALL substrings must be present (AND).
   * Subclasses that add rules should return `[...specific, ...super.errorRules()]`.
   */
  protected handleApiError(error: unknown, context: string, response?: Response): never {
    const headers: Record<string, string> = {};
    let statusCode: number | undefined;

    if (response) {
      statusCode = response.status;
      // `headers` is always present on a real Response, but test doubles may
      // omit it — classification must not depend on it.
      response.headers?.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    }

    if (error instanceof Error) {
      const message = error.message;
      for (const rule of this.errorRules()) {
        const matched = rule.match instanceof RegExp
          ? rule.match.test(message)
          : rule.match.every((needle) => message.includes(needle));
        if (matched) {
          throw new ApiError(`${context}: ${rule.message}`, rule.status, headers);
        }
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    // O1: upstream error bodies can echo request headers (proxy misconfig);
    // never embed them verbatim — redact and cap before surfacing.
    throw new ApiError(`${context}: ${redactTruncated(message)}`, statusCode, headers);
  }

  /**
   * M8: shared error classification table. The common provider-agnostic rules
   * live here so every client classifies 401/429/403/404 identically
   * (`rate limit` AND `rate_limit` both match; 403/404 are no longer
   * provider-specific gaps).
   */
  protected errorRules(): Array<{ match: RegExp | string[]; status?: number; message: string }> {
    return [
      { match: /401|invalid_api_key|Unauthorized/, status: 401, message: 'Invalid API key' },
      { match: /429|rate limit|rate_limit/, status: 429, message: 'Rate limit exceeded' },
      { match: /403|Forbidden/, status: 403, message: 'Access forbidden. Check API key permissions' },
      { match: /model_not_found|invalid_model/, status: 404, message: `Model '${this.model}' not found` },
    ];
  }

  /**
   * Template method for the non-streaming request pipeline (audit round3 T15/M1).
   *
   * Unified sequence shared by all clients:
   *   fetch → !ok → handleApiError → parse
   * with a single catch that re-wraps every failure — including the ApiError
   * thrown by the !ok branch and errors thrown by `parse` — through
   * handleApiError (preserving the historical double-wrap error messages).
   *
   * `op` names the operation for both error contexts: `${op} API error` on the
   * !ok path, `Failed to call ${op} API` on the catch path; pass
   * `failureContext` to override the latter (Ollama appends a hint sentence).
   */
  protected async withChatErrorHandling<T>(
    op: string,
    request: ApiRequestInit,
    parse: (data: Record<string, unknown>) => T,
    failureContext?: string,
  ): Promise<T> {
    let response: Response | undefined;
    // O1: every LLM request gets a lifecycle trace — without it a 429/500/timeout
    // is indistinguishable from a dead key in the logs.
    const startedAt = Date.now();
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers ?? this.buildHeaders(),
        body: JSON.stringify(request.body),
        signal: request.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), `${op} API error`, response);
      }

      const data = await response.json() as Record<string, unknown>;
      return parse(data);
    } catch (error) {
      logger.api.error('llm request failed', {
        op,
        model: this.model,
        baseUrl: this.baseUrl,
        statusCode: response?.status ?? (error instanceof ApiError ? error.statusCode : undefined),
        durationMs: Date.now() - startedAt,
        message: redactTruncated(error instanceof Error ? error.message : String(error)),
      });
      this.handleApiError(error, failureContext ?? `Failed to call ${op} API`);
    }
  }

  /**
   * Template method for the streaming request pipeline (audit round3 T15/M1).
   *
   * Unified sequence shared by all clients:
   *   fetch → !ok → handleApiError → body-null guard → yield* frames
   * with the identical catch-yield-error-finally-cancel epilogue: any failure
   * is yielded as a single `{ type: 'error' }` event and the response body is
   * cancelled when the generator exits. SSE/NDJSON frame parsing itself stays
   * in the subclass (`gen` receives the validated ReadableStream).
   *
   * `op` names the operation for the !ok error context (`${op} API error`).
   */
  protected async *withStreamErrorHandling(
    op: string,
    request: ApiRequestInit,
    gen: (body: ReadableStream) => AsyncGenerator<LLMStreamEvent>,
  ): AsyncGenerator<LLMStreamEvent> {
    let response: Response | undefined;
    const startedAt = Date.now();
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers ?? this.buildHeaders(),
        body: JSON.stringify(request.body),
        signal: request.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.handleApiError(new Error(`HTTP ${response.status}: ${errorText}`), `${op} API error`, response);
      }

      if (!response.body) {
        throw new Error('Response body is null');
      }

      yield* gen(response.body);
    } catch (error) {
      // O1: same lifecycle trace as the non-streaming pipeline; the event is
      // additionally yielded as `{ type: 'error' }` below (existing contract).
      logger.api.error('llm request failed', {
        op,
        model: this.model,
        baseUrl: this.baseUrl,
        statusCode: response?.status ?? (error instanceof ApiError ? error.statusCode : undefined),
        durationMs: Date.now() - startedAt,
        message: redactTruncated(error instanceof Error ? error.message : String(error)),
      });
      yield {
        type: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    } finally {
      // The !ok path consumes the body via text(), which leaves the stream
      // locked in undici — cancel() then rejects. Cleanup is best-effort.
      try {
        await response?.body?.cancel();
      } catch {
        /* body already consumed or locked by the frame reader */
      }
    }
  }

  /**
   * Read a streaming HTTP body and yield complete frames split by `delimiter`
   * ('\n' for NDJSON / line-based SSE, '\n\n' for block-based SSE).
   * The trailing partial frame (if any) is yielded after the stream ends.
   * Shared framing logic for all provider stream parsers — subclasses keep
   * only their frame→event semantic mapping.
   */
  protected async *readStreamFrames(
    body: ReadableStream,
    delimiter: '\n' | '\n\n',
  ): AsyncGenerator<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Flush any trailing partial frame
          if (buffer.length > 0) yield buffer;
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Emit complete frames using indexOf to avoid array allocation
        let start = 0;
        while (true) {
          const idx = buffer.indexOf(delimiter, start);
          if (idx === -1) break;
          const frame = buffer.slice(start, idx);
          start = idx + delimiter.length;
          if (frame.length > 0) yield frame;
        }

        // Keep unprocessed remainder
        buffer = start > 0 ? buffer.slice(start) : buffer;
      }
    } finally {
      reader.releaseLock();
    }
  }
}
