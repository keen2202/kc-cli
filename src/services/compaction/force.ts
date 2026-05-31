// Force Truncation Engine
// Priority 30 - last resort. Self-contained implementation.
// Always returns canHandle=true as a fallback.

import type { ChatMessage } from '../../types/message';
import type { CompactionEngine, CompactionContext, CompactionEngineResult } from './types';
import { ok, err } from '../../types/result';
import { estimateMessageTokens, estimateMessageTokensArray } from '../../utils/tokenEstimation';

/** Absolute token limit for force truncation */
const MAX_TOKEN_LIMIT = 128_000;

/**
 * Force truncate: keep most recent messages up to half the token limit.
 */
function forceTruncate(messages: ChatMessage[]): { messages: ChatMessage[]; tokensSaved: number } {
  const targetTokens = Math.floor(MAX_TOKEN_LIMIT / 2);
  const originalTokens = estimateMessageTokensArray(messages);

  // Keep messages from the end until we're under the target
  const kept: ChatMessage[] = [];
  let runningTokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(messages[i]);
    if (runningTokens + msgTokens > targetTokens && kept.length > 10) break;
    kept.unshift(messages[i]);
    runningTokens += msgTokens;
  }

  const tokensSaved = Math.max(0, originalTokens - runningTokens);

  return {
    messages: kept,
    tokensSaved,
  };
}

/**
 * Force truncation engine.
 * Last resort strategy that always claims it can handle compaction.
 * Truncates messages from the beginning to fit within token limits.
 */
export class ForceTruncationEngine implements CompactionEngine {
  readonly name = 'force';
  readonly priority = 30;

  canHandle(_messages: ChatMessage[], _context: CompactionContext): boolean {
    // Always true - this is the fallback engine
    return true;
  }

  async compact(messages: ChatMessage[], _context: CompactionContext): Promise<CompactionEngineResult> {
    try {
      const originalTokens = estimateMessageTokensArray(messages);
      const result = forceTruncate(messages);
      const newTokens = estimateMessageTokensArray(result.messages);

      return ok({
        messages: result.messages,
        tokensSaved: Math.max(0, originalTokens - newTokens),
        method: 'force',
      });
    } catch (error) {
      return err({
        code: 'FORCE_TRUNCATE_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
