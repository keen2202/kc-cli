// Base API Client - Abstract interface for LLM providers

import type { ChatMessage, ToolCall } from '../types/message';
import type { ToolDefinition } from '../types/tools';
import { zodToJsonSchema } from '../utils/zodToJsonSchema';

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'stop' | 'error';
  text?: string;
  toolCall?: ToolCall;
  error?: Error;
  usage?: TokenUsage;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export interface LLMRequestConfig {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  abortSignal?: AbortSignal;
  /** Ephemeral per-turn content (memory context, level adaptation) that should NOT break cache prefix */
  ephemeralContent?: string;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
}

/**
 * Structured API error with HTTP metadata for error classification.
 */
export class ApiError extends Error {
  statusCode?: number;
  responseHeaders?: Record<string, string>;

  constructor(message: string, statusCode?: number, responseHeaders?: Record<string, string>) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.responseHeaders = responseHeaders;
  }
}

/**
 * Abstract base class for all LLM API clients.
 * Provides a unified interface for streaming and non-streaming responses.
 */
export abstract class BaseApiClient {
  protected apiKey: string;
  protected baseUrl: string;
  protected model: string;

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
   * Subclasses can override for provider-specific formatting
   */
  protected formatMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
    return messages.map(msg => {
      const formatted: Record<string, unknown> = {
        role: msg.role,
        content: msg.content,
      };

      if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
        formatted.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.toolName,
            arguments: JSON.stringify(tc.input),
          },
        }));
      }

      if (msg.role === 'tool' && msg.toolResults && msg.toolResults.length > 0) {
        // Tool results are handled separately in most APIs
        // This is a simplified version
        formatted.content = msg.toolResults.map(r => r.output).join('\n');
      }

      return formatted;
    });
  }

  /**
   * Format tools for API request
   * Subclasses can override for provider-specific formatting
   */
  protected formatTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: this.extractSchemaParameters(tool.inputSchema),
      },
    }));
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
      return zodToJsonSchema(schema as any);
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
