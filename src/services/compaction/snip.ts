// Snip Compaction Engine
// Priority 10 - targeted removal of large tool outputs without touching conversation flow.
// Replaces large tool results with truncated versions.

import type { ChatMessage } from '../../types/message';
import type { CompactionEngine, CompactionContext, CompactionEngineResult } from './types';
import { ok, err } from '../../types/result';
import { estimateMessageTokensArray } from '../../utils/tokenEstimation';

/** Threshold in characters for a tool result to be considered "large" */
const LARGE_OUTPUT_THRESHOLD = 5000;

/** Maximum characters to keep in truncated output */
const TRUNCATED_OUTPUT_MAX = 500;

/**
 * Snip compaction engine.
 * Performs targeted removal of large tool outputs (>5000 chars)
 * without disturbing the conversation flow.
 */
export class SnipCompactionEngine implements CompactionEngine {
  readonly name = 'snip';
  readonly priority = 10;

  canHandle(messages: ChatMessage[], _context: CompactionContext): boolean {
    return messages.some(msg =>
      msg.role === 'tool' &&
      msg.toolResults?.some(tr => String(tr.output).length > LARGE_OUTPUT_THRESHOLD)
    );
  }

  async compact(messages: ChatMessage[], _context: CompactionContext): Promise<CompactionEngineResult> {
    try {
      const originalTokens = estimateMessageTokensArray(messages);
      let hasSnipped = false;

      const snipped = messages.map(msg => {
        if (msg.role !== 'tool' || !msg.toolResults) {
          return msg;
        }

        const newResults = msg.toolResults.map(tr => {
          const output = String(tr.output);
          if (output.length <= LARGE_OUTPUT_THRESHOLD) {
            return tr;
          }

          hasSnipped = true;
          const truncated = output.slice(0, TRUNCATED_OUTPUT_MAX);
          return {
            ...tr,
            output: `${truncated}\n\n[Output truncated - ${output.length} chars]`,
          };
        });

        // Only create new message if we actually snipped something
        const didSnip = newResults.some((r, i) => r !== msg.toolResults![i]);
        if (!didSnip) {
          return msg;
        }

        return {
          ...msg,
          toolResults: newResults,
        };
      });

      if (!hasSnipped) {
        return ok({
          messages,
          tokensSaved: 0,
          method: 'snip:noop',
        });
      }

      const newTokens = estimateMessageTokensArray(snipped);
      return ok({
        messages: snipped,
        tokensSaved: Math.max(0, originalTokens - newTokens),
        method: 'snip',
      });
    } catch (error) {
      return err({
        code: 'SNIP_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
