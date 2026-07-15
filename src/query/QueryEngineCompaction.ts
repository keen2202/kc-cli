// QueryEngine compaction phase logic

import { logger } from '../services/logger';
import type { ChatMessage, TurnTag } from '../query/protocol';
import { shouldCompact, microcompact, fullCompact, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, needsForceTruncation, forceTruncate } from '../services/compaction';
import { estimateMessageTokensArray } from '../utils/tokenEstimation';
import type { BaseApiClient } from '../api';
import { classifyApiError, getRetryDelay } from '../services/error-classifier';
import { StateValidator } from '../services/stateValidator';
import { withTimeout } from '../utils/async-helpers';
import { getErrorMessage } from '../utils/errors';

/**
 * Configuration for compaction phase.
 */
export interface CompactionConfig {
  contextWindow: number;
  model: string;
  systemPrompt?: string;
  /** Tracked modified files to preserve in summary */
  modifiedFiles?: string[];
}

/**
 * Handles the compaction phase of QueryEngine.
 * Delegates to compaction service for actual compaction logic.
 */
export class CompactionHandler {
  private compactFailureCount = 0;
  private stateValidator = new StateValidator();
  private maxConsecutiveFailures = MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;

  // ── Async (fire-and-forget) compaction state ──
  /** Promise for a pending async full-compact operation */
  private pendingCompactPromise: Promise<void> | null = null;
  /** Compacted messages from a completed async compaction */
  private pendingCompactMessages: ChatMessage[] | null = null;
  /** Whether the pending async compaction has finished */
  private pendingCompactDone = false;
  /** Error message from a failed async compaction, null if no error or success */
  private pendingCompactError: string | null = null;
  /** Number of messages at the time the async compaction was triggered */
  private pendingCompactMsgCount = 0;

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
   */
  async compact(
    messages: ChatMessage[],
    apiClient: BaseApiClient,
    config: CompactionConfig
  ): Promise<{ messages: ChatMessage[]; method: string }> {
    const compactConfig = {
      contextWindow: config.contextWindow,
      model: config.model,
    };

    // Check if force truncation is needed (absolute token limit exceeded)
    if (needsForceTruncation(messages)) {
      const result = forceTruncate(messages);
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
          fullResult = await withTimeout(
            fullCompact(
              workingMessages,
              apiClient,
              compactConfig,
              config.systemPrompt,
              config.modifiedFiles
            ),
            compactionTimeoutMs,
            `Compaction timed out after ${compactionTimeoutMs / 1000}s`,
          );
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

  /**
   * Prune failed_attempt messages older than maxAge turns.
   * These are dead ends — keep a 1-line marker, drop the content.
   */
  pruneFailedAttempts(
    messages: ChatMessage[],
    tags: Map<string, TurnTag>,
    maxAge: number
  ): { messages: ChatMessage[]; pruned: number } {
    let pruned = 0;
    const kept: ChatMessage[] = [];

    for (let idx = 0; idx < messages.length; idx++) {
      const msg = messages[idx];
      const tag = tags.get(msg.id);
      const age = messages.length - idx;

      if (tag && tag.importance === 'failed_attempt' && age > maxAge) {
        pruned++;
        // Skip this message (prune it)
        continue;
      }
      kept.push(msg);
    }

    return { messages: kept, pruned };
  }

  /**
   * Identify old exploration messages for compaction.
   * Returns messages eligible for summarization (older than maxAge).
   * key_finding messages are never eligible.
   */
  getExplorationToCompact(
    messages: ChatMessage[],
    tags: Map<string, TurnTag>,
    maxAge: number
  ): ChatMessage[] {
    return messages.filter((msg, idx) => {
      const tag = tags.get(msg.id);
      if (!tag || tag.importance !== 'exploration') return false;
      return (messages.length - idx) > maxAge;
    });
  }

  /** Reset failure count and clear pending async compaction */
  reset(): void {
    this.compactFailureCount = 0;
    this.pendingCompactPromise = null;
    this.pendingCompactMessages = null;
    this.pendingCompactDone = false;
    this.pendingCompactError = null;
    this.pendingCompactMsgCount = 0;
  }

  // ── Async (fire-and-forget) Entry Points ──

  /**
   * Trigger full compaction asynchronously (fire-and-forget).
   * The LLM-based summarization runs in the background; the result can be
   * retrieved later via {@link drainPendingCompactResult} (e.g. on the next
   * streaming cycle).
   *
   * Caches the promise: redundant triggers before completion are no-ops.
   * Always returns immediately (< 50 ms) — no LLM call is awaited.
   *
   * @param messages  Conversation messages to compact.
   * @param apiClient API client for the LLM summarization call.
   * @param config    Compaction configuration (context window, model, etc.).
   */
  triggerFullCompactAsync(
    messages: ChatMessage[],
    apiClient: BaseApiClient,
    config: CompactionConfig
  ): void {
    // Cache: don't start a second compaction while one is in flight
    if (this.pendingCompactPromise !== null) return;

    const compactConfig = {
      contextWindow: config.contextWindow,
      model: config.model,
    };

    // Snapshot the message count so we can correctly merge any messages that
    // are added while the async compaction is in flight.
    this.pendingCompactMsgCount = messages.length;

    // Fire-and-forget: run the full compact (including microcompact internally)
    // in the background without blocking the caller.
    this.pendingCompactPromise = this.#runFullCompactAsync(
      messages, apiClient, compactConfig, config,
    ).then(messages => {
      this.pendingCompactMessages = messages;
      this.pendingCompactDone = true;
    }).catch((err) => {
      this.pendingCompactError = getErrorMessage(err);
      this.pendingCompactDone = true;
      logger.query.error('[compaction] Async full compaction failed', { error: getErrorMessage(err) });
    });
  }

  /**
   * Drain a completed async compaction result.
   *
   * @param currentMessages  The current conversation messages (may include
   *                         messages added after the async compaction was
   *                         triggered).  These are appended after the
   *                         compacted message slice so that nothing is lost.
   * @returns The merged compacted message list with method name, or `null` if
   *          no compaction has finished yet (still pending / never triggered).
   *
   * Clears the pending state after draining so a future trigger can start
   * a new compaction cycle.
   */
  drainPendingCompactResult(
    currentMessages: ChatMessage[],
  ): { messages: ChatMessage[]; method: string } | null {
    if (this.pendingCompactPromise === null || !this.pendingCompactDone) {
      return null;
    }

    this.pendingCompactPromise = null;
    this.pendingCompactDone = false;

    const compactedMessages = this.pendingCompactMessages;
    this.pendingCompactMessages = null;

    if (compactedMessages === null) {
      this.pendingCompactMsgCount = 0;
      if (this.pendingCompactError) {
        logger.query.warn('[compaction] Drain found failed async compaction', { error: this.pendingCompactError });
        this.pendingCompactError = null;
      }
      return null;
    }

    // Merge: replace the trigger-time messages with the compacted version,
    // preserving any messages that were added while compaction was running.
    const triggerCount = this.pendingCompactMsgCount;
    this.pendingCompactMsgCount = 0;

    const newMessages = currentMessages.slice(triggerCount);
    const merged = [...compactedMessages, ...newMessages];

    return { messages: merged, method: 'fullcompact' as const };
  }

  /**
   * Internal async runner for LLM-based full compaction.
   * Delegates to the standalone `fullCompact` function which already includes
   * a microcompact pass as its first step.
   */
  async #runFullCompactAsync(
    messages: ChatMessage[],
    apiClient: BaseApiClient,
    compactConfig: { contextWindow: number; model: string },
    config: CompactionConfig,
  ): Promise<ChatMessage[] | null> {
    try {
      const result = await fullCompact(
        messages,
        apiClient,
        compactConfig,
        config.systemPrompt,
        config.modifiedFiles,
      );

      if (result.wasCompacted) {
        this.compactFailureCount = 0;
        return result.messages;
      }

      this.compactFailureCount = 0;
      return null;
    } catch (err) {
      this.compactFailureCount++;
      throw err;
    }
  }
}
