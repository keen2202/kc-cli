// Token estimation utilities - character-based heuristic

import type { ChatMessage } from '../types/message';

/**
 * Estimate tokens in a text string using character-based heuristic.
 * Uses the OpenHarness approach: (length + 3) / 4 with 4/3 padding factor.
 *
 * This avoids native dependencies like tiktoken while providing
 * reasonable accuracy for context window management.
 */
export function estimateTokens(text: string): number {
  if (!text || text.length === 0) {
    return 0;
  }

  // Base estimate: ~4 characters per token (English text average)
  const baseEstimate = (text.length + 3) / 4;

  // Add 4/3 padding factor for safety margin
  return Math.ceil(baseEstimate * (4 / 3));
}

/**
 * Estimate tokens in a single message including role and content
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 0;

  // Role overhead (~4 tokens per message)
  tokens += 4;

  // Content tokens
  if (message.content) {
    tokens += estimateTokens(message.content);
  }

  // Tool calls overhead (~10 tokens per call + input tokens)
  if (message.toolCalls && message.toolCalls.length > 0) {
    for (const toolCall of message.toolCalls) {
      tokens += 10; // overhead
      tokens += estimateTokens(JSON.stringify(toolCall.input || {}));
    }
  }

  // Tool results overhead (~10 tokens per result + output tokens)
  if (message.toolResults && message.toolResults.length > 0) {
    for (const result of message.toolResults) {
      tokens += 10; // overhead
      tokens += estimateTokens(result.output || '');
    }
  }

  return tokens;
}

/**
 * Estimate total tokens in a message array
 */
export function estimateMessageTokensArray(messages: ChatMessage[]): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
}

/**
 * Estimate tokens for a tool call input
 */
export function estimateToolCallTokens(input: Record<string, unknown>): number {
  return estimateTokens(JSON.stringify(input));
}

/**
 * Estimate tokens for a tool result output
 */
export function estimateToolResultTokens(output: string): number {
  return estimateTokens(output);
}

/**
 * Calculate tokens saved by compaction
 */
export function calculateTokensSaved(before: ChatMessage[], after: ChatMessage[]): number {
  return estimateMessageTokensArray(before) - estimateMessageTokensArray(after);
}
