// Shared AgentEvent factory helpers for the QueryEngine facade and its phase
// modules (streaming, execution, turn control). Extracted from QueryEngine
// (architecture 4e) — pure object-literal factories, no behavior change.

import type { AgentEvent } from '../state/types';
import type { AssistantMessage, ToolCall, ToolResult } from './protocol';

export function textDeltaEvent(text: string): AgentEvent {
  return { type: 'agent:text_delta', text, timestamp: Date.now() };
}

export function thinkingDeltaEvent(thinking: string): AgentEvent {
  return { type: 'agent:thinking_delta', thinking, timestamp: Date.now() };
}

export function turnCompleteEvent(
  message: AssistantMessage,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
): AgentEvent {
  return {
    type: 'agent:turn_complete',
    message,
    usage: usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    timestamp: Date.now(),
  };
}

export function toolStartedEvent(toolCall: ToolCall): AgentEvent {
  return { type: 'agent:tool_started', toolCall, timestamp: Date.now() };
}

export function toolCompletedEvent(toolCall: ToolCall, result: ToolResult): AgentEvent {
  return { type: 'agent:tool_completed', toolCall, result, timestamp: Date.now() };
}

export function toolFailedEvent(toolCall: ToolCall, error: Error): AgentEvent {
  return { type: 'agent:tool_failed', toolCall, error, timestamp: Date.now() };
}
