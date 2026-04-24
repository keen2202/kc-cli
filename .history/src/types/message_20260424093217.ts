// Message types for the conversation system

import type { ToolResult as ToolResultGeneric } from './tools';

// Re-export ToolResult<string> for backward compatibility
// This is the ToolResult type used in message passing (string output)
export type ToolResult = ToolResultGeneric<string>;

export type Role = 'user' | 'assistant' | 'system' | 'tool';

export interface Message {
  id: string;
  role: Role;
  content: string | null;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

/**
 * ToolResult for message passing (string output)
 * Re-exports the unified ToolResult from tools.ts
 * toolCallId is required for message context, output is string for serialization
 */
export type ToolResultMessage = Omit<ToolResult, 'toolCallId' | 'output'> & {
  toolCallId: string;
  output: string;
};

export interface UserMessage extends Message {
  role: 'user';
  content: string;
}

export interface AssistantMessage extends Message {
  role: 'assistant';
  content: string | null;
  toolCalls?: ToolCall[];
}

export interface SystemMessage extends Message {
  role: 'system';
  content: string;
}

export interface ToolMessage extends Message {
  role: 'tool';
  toolResults: ToolResult[];
}

export type ChatMessage = UserMessage | AssistantMessage | SystemMessage | ToolMessage;

// Streaming events
export type StreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; toolCall: ToolCall }
  | { type: 'tool_use_end'; toolCall: ToolCall; result: ToolResult }
  | { type: 'error'; error: Error }
  | { type: 'complete'; message: AssistantMessage };
