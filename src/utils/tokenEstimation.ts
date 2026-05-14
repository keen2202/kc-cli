// Token estimation utilities - tiktoken-based with character heuristic fallback
// Provides precise token counting using js-tiktoken with LRU caching.

import type { ChatMessage } from '../types/message';

// Lazy-loaded tiktoken encoder
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

export type TokenEncoding = 'cl100k_base' | 'o200k_base' | 'tiktoken' | 'custom';

/**
 * Token counter with FIFO cache for avoiding redundant encoding.
 */
export class TokenCounter {
  private encoder: any = null;
  private cache = new Map<string, number>();
  private maxCacheSize: number;
  private provider: string;
  private model: string;
  private encoding: TokenEncoding;

  constructor(provider: string, model: string, maxCacheSize = 1000, encoding?: TokenEncoding) {
    this.provider = provider;
    this.model = model;
    this.maxCacheSize = maxCacheSize;
    this.encoding = encoding ?? this.inferEncoding(provider, model);
  }

  /**
   * Count tokens in a text string.
   */
  count(text: string): number {
    if (!text || text.length === 0) return 0;

    // Check cache first
    const cached = this.cache.get(text);
    if (cached !== undefined) return cached;

    // Get encoder
    if (!this.encoder) {
      this.encoder = this.getEncoder();
    }

    let result: number;
    if (this.encoder) {
      try {
        result = this.encoder.encode(text).length;
      } catch {
        result = this.heuristicCount(text);
      }
    } else {
      result = this.heuristicCount(text);
    }

    // Cache the result (with eviction)
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(text, result);

    return result;
  }

  /**
   * Count tokens in a message array.
   */
  countMessages(messages: ChatMessage[]): number {
    return messages.reduce((total, msg) => total + this.countMessage(msg), 0);
  }

  /**
   * Count tokens in a single message.
   */
  countMessage(message: ChatMessage): number {
    let tokens = 4; // Role overhead

    if (message.content) {
      tokens += this.count(message.content);
    }

    if (message.toolCalls && message.toolCalls.length > 0) {
      for (const toolCall of message.toolCalls) {
        tokens += 10; // Structural overhead
        tokens += this.count(JSON.stringify(toolCall.input || {}));
      }
    }

    if (message.toolResults && message.toolResults.length > 0) {
      for (const result of message.toolResults) {
        tokens += 10; // Structural overhead
        tokens += this.count(result.output || '');
      }
    }

    return tokens;
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  private getEncoder(): any {
    try {
      const tiktoken = require('js-tiktoken');
      // Use encoding from capabilities if available
      if (this.encoding === 'o200k_base') {
        return tiktoken.get_encoding('o200k_base');
      }
      if (this.encoding === 'cl100k_base') {
        return tiktoken.get_encoding('cl100k_base');
      }
      // For 'custom' or 'tiktoken', try model-specific first
      try {
        return tiktoken.encoding_for_model(this.model as any);
      } catch {
        return tiktoken.get_encoding('cl100k_base');
      }
    } catch {
      return null;
    }
  }

  /**
   * Infer the best encoding from provider and model names.
   */
  private inferEncoding(provider: string, model: string): TokenEncoding {
    // Anthropic uses its own tokenizer, but cl100k is a reasonable approximation
    if (provider === 'anthropic') return 'cl100k_base';
    // GPT-4o and newer OpenAI models use o200k
    if (provider === 'openai' && (model.includes('gpt-4o') || model.includes('o1') || model.includes('o3'))) return 'o200k_base';
    // Default to cl100k for most models
    return 'cl100k_base';
  }

  private heuristicCount(text: string): number {
    return Math.ceil(((text.length + 3) / 4) * (4 / 3));
  }
}

// Singleton instance for backward compatibility
let defaultCounter: TokenCounter | null = null;

function getDefaultCounter(): TokenCounter {
  if (!defaultCounter) {
    defaultCounter = new TokenCounter('openai', 'gpt-4o');
  }
  return defaultCounter;
}

/**
 * Count tokens in a text string using tiktoken (exact count).
 * Falls back to character heuristic if tiktoken is unavailable.
 */
export function countTokens(text: string): number {
  return getDefaultCounter().count(text);
}

/**
 * Estimate tokens in a text string (alias for countTokens).
 */
export function estimateTokens(text: string): number {
  return countTokens(text);
}

/**
 * Estimate tokens in a single message including role and content overhead.
 */
export function estimateMessageTokens(message: ChatMessage): number {
  return getDefaultCounter().countMessage(message);
}

/**
 * Estimate total tokens in a message array.
 */
export function estimateMessageTokensArray(messages: ChatMessage[]): number {
  return getDefaultCounter().countMessages(messages);
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
  if (defaultCounter) {
    defaultCounter.clearCache();
  }
}
