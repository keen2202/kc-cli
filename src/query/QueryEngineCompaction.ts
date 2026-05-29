// QueryEngine compaction phase logic

import { logger } from '../services/logger';
import type { ChatMessage, StreamEvent } from '../types/message';
import type { AgentEvent } from '../state/types';
import { shouldCompact, microcompact, fullCompact, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, needsForceTruncation, forceTruncate } from '../services/compaction';
import { estimateMessageTokensArray } from '../utils/tokenEstimation';
import type { BaseApiClient } from '../api';
import { classifyApiError, getRetryDelay } from '../services/error-classifier';
import { StateValidator } from '../services/stateValidator';

/**
 * Configuration for compaction phase.
 */
export interface CompactionConfig {
  contextWindow: number;
  model: string;
  systemPrompt?: string;
}

/**
 * Handles the compaction phase of QueryEngine.
 * Delegates to compaction service for actual compaction logic.
 */
export class CompactionHandler {
  private compactFailureCount = 0;
  private stateValidator = new StateValidator();
  private maxConsecutiveFailures = MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;

  constructor(maxFailures?: number) {
    if (maxFailures !== undefined) {
      this.maxConsecutiveFailures = maxFailures;
    }
  }

  /** Get current failure count */
  get failureCount(): number {
    return this.compactFailureCount;
  }

  /** Check if compaction should be attempted */
  shouldAttemptCompaction(messages: ChatMessage[], config: CompactionConfig): boolean {
    if (this.compactFailureCount >= this.maxConsecutiveFailures) {
      return false;
    }

    // Check absolute limit first
    if (needsForceTruncation(messages)) {
      return true;
    }

    const compactConfig = {
      contextWindow: config.contextWindow,
      model: config.model,
    };

    return shouldCompact(messages, compactConfig, this.compactFailureCount);
  }

  /**
   * Execute compaction on messages.
   * Uses three-tier strategy: microcompact → full compact → force truncate.
   * Yields events as compaction progresses.
   */
  async *compact(
    messages: ChatMessage[],
    apiClient: BaseApiClient,
    config: CompactionConfig
  ): AsyncGenerator<AgentEvent | StreamEvent> {
    const compactConfig = {
      contextWindow: config.contextWindow,
      model: config.model,
    };

    // Check if force truncation is needed (absolute token limit exceeded)
    if (needsForceTruncation(messages)) {
      const result = forceTruncate(messages);
      yield {
        type: 'agent:compact_full',
        originalTokens: estimateMessageTokensArray(messages),
        compactedTokens: estimateMessageTokensArray(result.messages),
        timestamp: Date.now(),
      };
      this.compactFailureCount = 0;
      return { messages: result.messages, method: 'force_truncate' as const };
    }

    // Validate state before compaction
    const validation = this.stateValidator.validate(messages);
    let workingMessages = messages;
    if (!validation.valid) {
      logger.query.warn(`State validation found ${validation.issues.length} issues before compaction, repairing...`);
      workingMessages = this.stateValidator.repair(messages, validation.issues);
    }

    try {
      // Try microcompact first (cheap, no LLM)
      const microResult = microcompact(workingMessages);

      if (microResult.wasCompacted) {
        yield {
          type: 'agent:compact_micro',
          tokensSaved: microResult.tokensSaved,
          timestamp: Date.now(),
        };

        const remainingTokens = estimateMessageTokensArray(microResult.messages);
        const threshold = config.contextWindow - 20_000 - 13_000;

        if (remainingTokens < threshold) {
          this.compactFailureCount = 0;
          return { messages: microResult.messages, method: 'microcompact' as const };
        }

        workingMessages = microResult.messages;
      }

      // Full LLM-based compaction with retry
      const maxCompactionRetries = 2;
      // Timeout for each compaction LLM call (default 60s)
      const COMPACTION_TIMEOUT_MS = parseInt(process.env.KC_COMPACTION_TIMEOUT_MS || '60000', 10);
      const compactionTimeoutMs = Number.isFinite(COMPACTION_TIMEOUT_MS) && COMPACTION_TIMEOUT_MS > 0
        ? COMPACTION_TIMEOUT_MS
        : 60000;
      let fullResult: { wasCompacted: boolean; messages: ChatMessage[]; tokensSaved: number } | null = null;

      for (let retryAttempt = 0; retryAttempt <= maxCompactionRetries; retryAttempt++) {
        try {
          // Race compaction against a timeout to prevent infinite hangs
          fullResult = await Promise.race([
            fullCompact(
              workingMessages,
              apiClient,
              compactConfig,
              config.systemPrompt
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Compaction timed out after ${compactionTimeoutMs / 1000}s`)), compactionTimeoutMs)
            ),
          ]);
          break;
        } catch (compactError) {
          const err = compactError instanceof Error ? compactError : new Error(String(compactError));
          const classified = classifyApiError(err);

          if (classified.retryable && retryAttempt < maxCompactionRetries) {
            const delay = classified.retryAfterMs ?? getRetryDelay(retryAttempt);
            logger.query.warn(`Compaction retry ${retryAttempt + 1}/${maxCompactionRetries} after ${delay}ms: ${err.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }

          throw compactError;
        }
      }

      if (fullResult && fullResult.wasCompacted) {
        const compactedTokens = estimateMessageTokensArray(fullResult.messages);
        yield {
          type: 'agent:compact_full',
          originalTokens: compactedTokens + fullResult.tokensSaved,
          compactedTokens,
          timestamp: Date.now(),
        };

        this.compactFailureCount = 0;
        return { messages: fullResult.messages, method: 'fullcompact' as const };
      }

      this.compactFailureCount = 0;
      return { messages: workingMessages, method: 'none' as const };
    } catch (error) {
      this.compactFailureCount++;
      if (this.compactFailureCount >= this.maxConsecutiveFailures) {
        logger.query.warn('Auto-compaction disabled after repeated failures');
      }
      return { messages, method: 'none' as const };
    }
  }

  /** Reset failure count */
  reset(): void {
    this.compactFailureCount = 0;
  }
}
