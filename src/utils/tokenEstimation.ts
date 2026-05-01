// Token estimation utilities - tiktoken-based with character heuristic fallback

import type { ChatMessage } from '../types/message';

// Lazy-loaded tiktoken encoder to avoid startup cost
let encoder: any = null;
let encoderLoadFailed = false;

function getEncoder(): any {
  if (encoderLoadFailed) return null;
  if (encoder) return encoder;

  try {
    const tiktoken = require('js-tiktoken');
    encoder = tiktoken.encoding_for_model('gpt-4o');
    return encoder;
  } catch {
    // Fallback: try cl100k_base
    try {
      const tiktoken = require('js-tiktoken');
      encoder = tiktoken.get_encoding('cl100k_base');
      return encoder;
    } catch {
      encoderLoadFailed = true;
      return null;
    }
  }
}

/**
 * Count tokens in a text string using tiktoken (exact count).
 * Falls back to character heuristic if tiktoken is unavailable.
 */
export function countTokens(text: string): number {
  if (!text || text.length === 0) return 0;

  const enc = getEncoder();
  if (enc) {
    try {
      return enc.encode(text).length;
    } catch {
      // Fall through to heuristic
    }
  }

  // Character heuristic fallback: ~4 chars per token + 4/3 safety margin
  return Math.ceil(((text.length + 3) / 4) * (4 / 3));
}

/**
 * Estimate tokens in a text string (alias for countTokens).
 * Uses tiktoken when available, character heuristic otherwise.
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/**
 * Estimate tokens in a single message including role and content overhead.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  let tokens = 0;

  // Role overhead (~4 tokens per message boundary)
  tokens += 4;

  // Content tokens
  if (message.content) {
    tokens += countTokens(message.content);
  }

  // Tool calls overhead (~10 tokens per call + input tokens)
  if (message.toolCalls && message.toolCalls.length > 0) {
    for (const toolCall of message.toolCalls) {
      tokens += 10; // structural overhead
      tokens += countTokens(JSON.stringify(toolCall.input || {}));
    }
  }

  // Tool results overhead (~10 tokens per result + output tokens)
  if (message.toolResults && message.toolResults.length > 0) {
    for (const result of message.toolResults) {
      tokens += 10; // structural overhead
      tokens += countTokens(result.output || '');
    }
  }

  return tokens;
}

/**
 * Estimate total tokens in a message array.
 */
export function estimateMessageTokensArray(messages: ChatMessage[]): number {
  return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
}

/**
 * Estimate tokens for a tool call input.
 */
export function estimateToolCallTokens(input: Record<string, unknown>): number {
  return countTokens(JSON.stringify(input));
}

/**
 * Estimate tokens for a tool result output.
 */
export function estimateToolResultTokens(output: string): number {
  return countTokens(output);
}

/**
 * Calculate tokens saved by compaction.
 */
export function calculateTokensSaved(before: ChatMessage[], after: ChatMessage[]): number {
  return estimateMessageTokensArray(before) - estimateMessageTokensArray(after);
}

/**
 * Free tiktoken encoder resources (for graceful shutdown).
 */
export function disposeTokenizer(): void {
  if (encoder && typeof encoder.free === 'function') {
    encoder.free();
  }
  encoder = null;
}
