// API client protocol types
//
// T18/M4 (audit round3): this module no longer imports query/tools modules —
// the shapes below are structural mirrors kept assignment-compatible with
// query/protocol's ChatMessage/ToolCall and the ToolDefinition data surface.
// A compile-time compatibility guard lives in test/api/protocol-decoupling.test.ts.

import type { z } from 'zod';

/** Structural mirror of query/protocol's ToolCall (identical shape). */
export interface ApiToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

/** Structural mirror of the message-passing ToolResult<string> shape. */
export interface ApiToolResultEntry {
  toolCallId?: string;
  output: string;
  isError: boolean;
  message?: string;
  metadata?: Record<string, unknown>;
  timedOut?: boolean;
}

/**
 * Structural supertype of query/protocol's ChatMessage union: every variant
 * (UserMessage/AssistantMessage/SystemMessage/ToolMessage) is assignable to
 * this, so conversation history flows into client calls unchanged.
 */
export interface ApiChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  toolCalls?: ApiToolCall[];
  toolResults?: ApiToolResultEntry[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

/**
 * Structural subset of tools/protocol's ToolDefinition that the API layer
 * consumes when formatting request payloads. Full tool definitions remain
 * assignable; `inputSchema` is treated opaquely at this boundary.
 */
export interface ApiToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
}

export interface LLMStreamEvent {
  type: 'text_delta' | 'tool_use' | 'tool_result' | 'stop' | 'error'
    | 'thinking_delta' | 'usage_update' | 'cache_status' | 'model_info';
  text?: string;
  toolCall?: ApiToolCall;
  error?: Error;
  usage?: TokenUsage;
  thinking?: string;
  cacheHit?: boolean;
  model?: string;
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
  messages: ApiChatMessage[];
  tools?: ApiToolSpec[];
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
  toolCalls?: ApiToolCall[];
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
