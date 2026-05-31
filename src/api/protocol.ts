// API client protocol types

import type { ChatMessage, ToolCall } from '../types/message';
import type { ToolDefinition } from '../types/tools';

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
