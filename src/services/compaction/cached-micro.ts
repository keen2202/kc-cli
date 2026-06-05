// Cached Micro Compaction Engine
// Priority 0 - tried first. Caches microcompact results per message hash
// to avoid redundant processing when messages haven't changed.

import type { ChatMessage } from '../../query/protocol';
import type { CompactionEngine, CompactionContext, CompactionEngineResult } from './types';
import { ok, err } from '../../utils/result';
import { estimateMessageTokensArray } from '../../utils/tokenEstimation';

/** Message to replace cleared tool results with */
const CLEARED_MESSAGE = '[Old tool result content cleared to conserve context window]';

/** Default number of recent messages to preserve */
const DEFAULT_KEEP_RECENT = 5;

/**
 * Simple hash of message content for cache key generation.
 * Uses a basic string hash to detect unchanged message arrays.
 */
function hashMessages(messages: ChatMessage[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    parts.push(msg.id);
    parts.push(msg.role);
    parts.push(msg.content ?? '');
    if (msg.toolCalls) {
      for (const tc of msg.toolCalls) {
        parts.push(tc.id);
        parts.push(tc.toolName);
      }
    }
    if (msg.toolResults) {
      for (const tr of msg.toolResults) {
        parts.push(tr.toolCallId ?? '');
        parts.push(String(tr.output));
      }
    }
  }
  return simpleHash(parts.join('\x00'));
}

/**
 * Simple DJB2 hash function for strings.
 */
function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Microcompact: cheap compaction that clears old tool results.
 * This is a fast, no-LLM operation.
 */
function microcompact(
  messages: ChatMessage[],
  keepRecent: number = DEFAULT_KEEP_RECENT
): { messages: ChatMessage[]; tokensSaved: number; wasCompacted: boolean } {
  if (messages.length <= keepRecent + 2) {
    return { messages, tokensSaved: 0, wasCompacted: false };
  }

  const originalTokens = estimateMessageTokensArray(messages);
  const compacted: ChatMessage[] = [];

  // Keep the most recent messages
  const messagesToKeep = messages.slice(-keepRecent - 2);

  // Clear tool results in older messages
  for (let i = 0; i < messages.length - messagesToKeep.length; i++) {
    const msg = messages[i];

    if (msg.role === 'tool' && msg.toolResults) {
      const hasCompactableTool = msg.toolResults.some(result => {
        return result.output && String(result.output).length > 50;
      });

      if (hasCompactableTool) {
        compacted.push({
          ...msg,
          toolResults: msg.toolResults.map(result => ({
            ...result,
            output: CLEARED_MESSAGE,
          })),
        });
      } else {
        compacted.push(msg);
      }
    } else {
      compacted.push(msg);
    }
  }

  // Add recent messages unchanged
  compacted.push(...messagesToKeep);

  const compactedTokens = estimateMessageTokensArray(compacted);
  const tokensSaved = originalTokens - compactedTokens;

  return {
    messages: compacted,
    tokensSaved,
    wasCompacted: tokensSaved > 0,
  };
}

/**
 * Cached micro compaction engine.
 * Wraps the microcompact function with result caching
 * to avoid redundant processing when messages haven't changed.
 */
export class CachedMicroCompactionEngine implements CompactionEngine {
  readonly name = 'cached-micro';
  readonly priority = 0;

  private cache = new Map<string, { result: CompactionEngineResult; timestamp: number }>();
  private maxCacheSize = 50;
  private maxCacheAge = 60_000; // 1 minute

  canHandle(_messages: ChatMessage[], context: CompactionContext): boolean {
    // Handle when we're at 80% of token budget
    return context.currentTokens > context.tokenBudget * 0.8;
  }

  async compact(messages: ChatMessage[], context: CompactionContext): Promise<CompactionEngineResult> {
    try {
      const hash = hashMessages(messages);

      // Check cache for valid entry
      const cached = this.cache.get(hash);
      if (cached && Date.now() - cached.timestamp < this.maxCacheAge) {
        return cached.result;
      }

      // Execute microcompact
      const result = microcompact(messages);

      if (!result.wasCompacted) {
        const noOpResult = ok({
          messages,
          tokensSaved: 0,
          method: 'cached-micro:noop',
        });
        this.setCache(hash, noOpResult);
        return noOpResult;
      }

      const compactResult = ok({
        messages: result.messages,
        tokensSaved: result.tokensSaved,
        method: 'cached-micro',
      });
      this.setCache(hash, compactResult);
      return compactResult;
    } catch (error) {
      return err({
        code: 'CACHED_MICRO_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clear the cache. Useful for testing or memory pressure.
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get current cache size.
   */
  get cacheSize(): number {
    return this.cache.size;
  }

  private setCache(hash: string, result: CompactionEngineResult): void {
    // Evict oldest entries if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(hash, { result, timestamp: Date.now() });
  }
}
