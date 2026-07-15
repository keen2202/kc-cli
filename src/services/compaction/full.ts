// Full Compaction Engine
// Priority 20 - LLM-based conversation summarization.
// Self-contained implementation that doesn't depend on the original compaction.ts.

import type { ChatMessage } from '../../query/protocol';
import type { CompactionEngine, CompactionContext, CompactionEngineResult } from './types';
import type { BaseApiClient } from '../../api/BaseApiClient';
import { ok, err } from './types';
import { estimateMessageTokensArray, calculateTokensSaved } from '../../utils/tokenEstimation';
import { classifyApiError, getRetryDelay } from '../error-classifier';
import { logger } from '../logger';
import { withTimeout, TimeoutError } from '../../utils/async-helpers';

/** Default compaction timeout in milliseconds */
const DEFAULT_COMPACTION_TIMEOUT_MS = 60_000;

/** Maximum retry attempts for compaction */
const MAX_COMPACTION_RETRIES = 2;

/** Number of recent messages to preserve during full compaction */
const PRESERVE_RECENT = 6;

/** Buffer tokens to leave room for response */
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

/** Maximum output tokens for summary */
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;

/**
 * Build the prompt for LLM-based conversation summarization
 */
function buildCompactPrompt(messagesToSummarize: ChatMessage[], systemPrompt: string): string {
  const conversationText = messagesToSummarize
    .map(msg => {
      const role = msg.role.toUpperCase();
      const content = msg.content || '[tool calls/results]';
      return `${role}: ${content}`;
    })
    .join('\n\n');

  return `Please summarize the following conversation concisely, preserving key information, decisions, and context that would be needed for future turns. Focus on what was accomplished and what is still pending.

<system_context>
${systemPrompt || 'You are an AI assistant helping with software development tasks.'}
</system_context>

<conversation_to_summarize>
${conversationText}
</conversation_to_summarize>

Provide a concise summary that captures:
1. What tasks were requested and completed
2. What files were created or modified
3. What decisions were made
4. What is still pending or incomplete
5. Any important technical details or context

Keep the summary under 500 words.`;
}

/**
 * Build a fallback summary when LLM API is unavailable
 */
function buildFallbackSummary(messages: ChatMessage[]): string {
  const parts: string[] = ['[Auto-generated summary - LLM unavailable]'];

  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      const preview = msg.content.slice(0, 100);
      parts.push(`User: ${preview}${msg.content.length > 100 ? '...' : ''}`);
    } else if (msg.role === 'assistant' && msg.content) {
      const preview = msg.content.slice(0, 100);
      parts.push(`Assistant: ${preview}${msg.content.length > 100 ? '...' : ''}`);
    }
  }

  return parts.join('\n');
}

/**
 * Full compaction: LLM-based conversation summarization.
 */
async function fullCompact(
  messages: ChatMessage[],
  apiClient: BaseApiClient,
  contextWindow: number,
  model: string,
  systemPrompt: string = '',
  abortSignal?: AbortSignal
): Promise<{ messages: ChatMessage[]; tokensSaved: number; wasCompacted: boolean }> {
  if (messages.length <= PRESERVE_RECENT + 2) {
    return { messages, tokensSaved: 0, wasCompacted: false };
  }

  try {
    // Split messages into old (to summarize) and recent (to preserve)
    const oldMessages = messages.slice(0, -PRESERVE_RECENT);
    const recentMessages = messages.slice(-PRESERVE_RECENT);

    // Build summary prompt
    const summaryPrompt = buildCompactPrompt(oldMessages, systemPrompt);

    // Call LLM to generate summary (no tools)
    let summaryResponse: string;
    try {
      const response = await apiClient.chat({
        model,
        messages: [{
          id: `summary_${Date.now()}`,
          role: 'user',
          content: summaryPrompt,
          timestamp: Date.now(),
        }],
        maxTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
        temperature: 0.3,
        stream: false,
        abortSignal,
      });
      summaryResponse = response.content;
    } catch {
      // If API client fails, fall back to a simple truncation summary
      summaryResponse = buildFallbackSummary(oldMessages);
    }

    // Build compacted messages
    const summaryMessage: ChatMessage = {
      id: `compact_${Date.now()}`,
      role: 'user',
      content: `<conversation_summary>\n${summaryResponse}\n</conversation_summary>`,
      timestamp: Date.now(),
    };

    const compactedMessages = [summaryMessage, ...recentMessages];
    const tokensSaved = calculateTokensSaved(messages, compactedMessages);

    return {
      messages: compactedMessages,
      tokensSaved,
      wasCompacted: true,
    };
  } catch (error) {
    // Return original messages on error
    return {
      messages,
      tokensSaved: 0,
      wasCompacted: false,
    };
  }
}

/**
 * Full compaction engine.
 * Uses LLM-based conversation summarization.
 * Includes retry logic and timeout handling.
 */
export class FullCompactionEngine implements CompactionEngine {
  readonly name = 'full';
  readonly priority = 20;

  private apiClient: BaseApiClient;
  private model: string;
  private systemPrompt: string;
  private compactionTimeoutMs: number;

  constructor(
    apiClient: BaseApiClient,
    model: string,
    systemPrompt: string = '',
    timeoutMs?: number
  ) {
    this.apiClient = apiClient;
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.compactionTimeoutMs = this.resolveTimeout(timeoutMs);
  }

  canHandle(_messages: ChatMessage[], context: CompactionContext): boolean {
    // Handle when we're above 80% of the token budget
    // This allows chaining: if a lighter engine reduces tokens but not enough,
    // this engine can still run as a fallback
    return context.currentTokens > context.tokenBudget * 0.8;
  }

  async compact(messages: ChatMessage[], context: CompactionContext): Promise<CompactionEngineResult> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_COMPACTION_RETRIES; attempt++) {
      const abortController = new AbortController();

      try {
        // Race compaction against timeout
        const result = await withTimeout(
          fullCompact(
            messages,
            this.apiClient,
            context.tokenBudget,
            this.model,
            this.systemPrompt,
            abortController.signal
          ),
          this.compactionTimeoutMs,
          `Compaction timed out after ${this.compactionTimeoutMs / 1000}s`,
        ).catch(compactError => {
          // On timeout (or any error), cancel in-flight LLM call
          abortController.abort();
          throw compactError;
        });

        if (result.wasCompacted) {
          return ok({
            messages: result.messages,
            tokensSaved: result.tokensSaved,
            method: 'full',
          });
        }

        // No compaction needed
        return ok({
          messages,
          tokensSaved: 0,
          method: 'full:noop',
        });
      } catch (compactError) {
        lastError = compactError instanceof Error ? compactError : new Error(String(compactError));

        // Don't retry timeout'd summaries
        if (lastError instanceof TimeoutError) {
          logger.query.warn(`Full compaction timed out, not retrying: ${lastError.message}`);
          break;
        }

        const classified = classifyApiError(lastError);

        if (classified.retryable && attempt < MAX_COMPACTION_RETRIES) {
          const delay = classified.retryAfterMs ?? getRetryDelay(attempt);
          logger.query.warn(`Full compaction retry ${attempt + 1}/${MAX_COMPACTION_RETRIES} after ${delay}ms: ${lastError.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        break;
      }
    }

    return err({
      code: 'FULL_COMPACTION_FAILED',
      message: lastError?.message ?? 'Unknown compaction error',
    });
  }

  /**
   * Resolve compaction timeout from environment or default.
   */
  private resolveTimeout(override?: number): number {
    if (override !== undefined && override > 0) {
      return override;
    }

    const envTimeout = parseInt(process.env.KC_COMPACTION_TIMEOUT_MS || '', 10);
    if (Number.isFinite(envTimeout) && envTimeout > 0) {
      return envTimeout;
    }

    return DEFAULT_COMPACTION_TIMEOUT_MS;
  }
}
