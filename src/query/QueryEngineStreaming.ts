// LLM stream consumption and API-message pairing repair, extracted from
// QueryEngine (architecture 4e). Pure move of streamLLMResponse /
// buildApiMessages — no behavior or event change.

import { logger } from '../services/logger';
import { v4 as uuidv4 } from 'uuid';
import type { LLMRequestConfig, BaseApiClient } from '../api';
import type { AgentEvent } from '../state/types';
import type { AssistantMessage, ChatMessage, StreamEvent, ToolCall } from './protocol';
import { textDeltaEvent, thinkingDeltaEvent, turnCompleteEvent } from './QueryEngineEvents';

/** Engine hooks the stream consumer needs, passed per call. */
export interface StreamTurnDeps {
  apiClient: BaseApiClient;
  isAborted(): boolean;
  abort(reason?: string): void;
  addMessage(message: ChatMessage): void;
}

/**
 * Consume one provider stream: map provider events to engine events, enforce
 * the global stream timeout, and append the resulting assistant message.
 */
export async function* streamLLMTurn(
  deps: StreamTurnDeps,
  requestConfig: LLMRequestConfig,
): AsyncGenerator<StreamEvent | AgentEvent> {
  let currentContent = '';
  const currentToolCalls: ToolCall[] = [];
  // Real usage reported by the provider's stop event (Anthropic/Ollama always,
  // OpenAI-compatible when stream_options.include_usage is honored).
  let turnUsage: { inputTokens: number; outputTokens: number; totalTokens: number } | undefined;

  // Global timeout for LLM streaming to prevent infinite hangs.
  // Default 5 minutes; can be overridden via environment variable.
  const STREAM_TIMEOUT_MS = parseInt(process.env.KC_STREAM_TIMEOUT_MS || '300000', 10);
  const streamTimeoutMs = Number.isFinite(STREAM_TIMEOUT_MS) && STREAM_TIMEOUT_MS > 0
    ? STREAM_TIMEOUT_MS
    : 300000;

  const timeoutId = setTimeout(() => {
    deps.abort('LLM stream timeout');
  }, streamTimeoutMs);
  timeoutId.unref?.();

  try {
    for await (const event of deps.apiClient.streamChat(requestConfig)) {
      if (deps.isAborted()) break;
      switch (event.type) {
        case 'text_delta':
          if (event.text) {
            currentContent += event.text;
            yield textDeltaEvent(event.text);
          }
          break;
        case 'thinking_delta':
          if (event.thinking) {
            yield thinkingDeltaEvent(event.thinking);
          }
          break;
        case 'tool_use':
          if (event.toolCall) {
            currentToolCalls.push(event.toolCall);
          }
          break;
        case 'error':
          if (event.error) throw event.error;
          break;
        case 'stop':
          if (event.usage) {
            turnUsage = {
              inputTokens: event.usage.inputTokens || 0,
              outputTokens: event.usage.outputTokens || 0,
              totalTokens: event.usage.totalTokens
                || (event.usage.inputTokens || 0) + (event.usage.outputTokens || 0),
            };
          }
          break;
      }
    }
  } catch (error) {
    if (deps.isAborted()) {
      // Preserve the underlying cause instead of replacing it with a generic
      // message — the original reason must reach the user, not just debug logs.
      const cause = error instanceof Error ? error : new Error(String(error));
      logger.query.warn(
        `[QueryEngine] LLM stream aborted (timeout ${streamTimeoutMs / 1000}s): ${cause.message}`
      );
      throw new Error(`LLM stream aborted: ${cause.message}`, { cause });
    } else {
      throw error;
    }
  } finally {
    clearTimeout(timeoutId);
  }

  // Build assistant message (with whatever content we have)
  const assistantMsg: AssistantMessage = {
    id: uuidv4(),
    role: 'assistant',
    content: currentContent || '[stream interrupted]',
    toolCalls: currentToolCalls.length > 0 ? currentToolCalls : undefined,
    timestamp: Date.now(),
  };

  deps.addMessage(assistantMsg);
  yield turnCompleteEvent(assistantMsg, turnUsage);
}

/**
 * Defensive pairing over a messages copy: the OpenAI contract requires every
 * assistant tool_call id to be answered by a following tool message with the
 * same tool_call_id. If any id is unanswered (e.g. a tool crashed before
 * producing a result), synthesize a placeholder tool message so the API does
 * not reject the request with HTTP 400.
 */
export function buildApiMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemMsg = messages.find(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');

  const repaired: ChatMessage[] = [];
  for (let i = 0; i < nonSystem.length; i++) {
    const msg = nonSystem[i];
    repaired.push(msg);

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Consume the immediately-following tool messages and record which
      // tool_call ids they answer.
      const answered = new Set<string>();
      let j = i + 1;
      while (j < nonSystem.length && nonSystem[j].role === 'tool') {
        for (const tr of nonSystem[j].toolResults || []) {
          if (tr.toolCallId) answered.add(tr.toolCallId);
        }
        repaired.push(nonSystem[j]);
        j++;
      }

      // Synthesize placeholders for any unanswered tool_call ids.
      for (const tc of msg.toolCalls) {
        if (!answered.has(tc.id)) {
          repaired.push({
            id: uuidv4(),
            role: 'tool',
            content: 'Tool execution did not produce a result.',
            toolResults: [{ toolCallId: tc.id, output: 'Tool execution did not produce a result.', isError: true }],
            timestamp: Date.now(),
          } as ChatMessage);
        }
      }

      i = j - 1; // Skip the tool messages already appended above.
    }
  }

  return systemMsg ? [systemMsg, ...repaired] : repaired;
}
