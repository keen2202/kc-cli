// Auto-compaction service - manages conversation context window

import type { ChatMessage } from '../query/protocol';
import {
  estimateMessageTokensArray,
  estimateMessageTokens,
  calculateTokensSaved,
} from '../utils/tokenEstimation';

// Compaction constants (from OpenHarness pattern)
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;
const PRESERVE_RECENT = 6; // Keep last N messages during full compact
const DEFAULT_KEEP_RECENT = 5; // Keep last N tool results during microcompact
/** Absolute token limit — force truncation when total estimated tokens exceed this */
export const MAX_TOKEN_LIMIT = 128_000;
/** Message count threshold for force truncation (fallback when token estimation unavailable) */
const MAX_MESSAGE_COUNT = 500;

// Tools with large outputs that are good compaction candidates
export const COMPACTABLE_TOOLS = new Set([
  'FileRead',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'FileEdit',
  'FileWrite',
]);

// Message to replace cleared tool results with
const TIME_BASED_MC_CLEARED_MESSAGE = '[Old tool result content cleared to conserve context window]';

/**
 * Context window configuration
 */
export interface CompactConfig {
  contextWindow: number; // Total context window (e.g., 200_000)
  model: string;
}

/**
 * Compaction service result
 */
export interface CompactionResult {
  messages: ChatMessage[];
  tokensSaved: number;
  wasCompacted: boolean;
  method: 'none' | 'microcompact' | 'fullcompact';
}

/**
 * Check if auto-compaction should be triggered
 */
export function shouldCompact(
  messages: ChatMessage[],
  config: CompactConfig,
  consecutiveFailures: number
): boolean {
  // Disable compaction after too many consecutive failures
  if (consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return false;
  }

  const tokenCount = estimateMessageTokensArray(messages);
  const threshold = config.contextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;

  return tokenCount >= threshold;
}

/**
 * Microcompact: cheap compaction that clears old tool results.
 * This is a fast, no-LLM operation.
 */
export function microcompact(
  messages: ChatMessage[],
  keepRecent: number = DEFAULT_KEEP_RECENT
): CompactionResult {
  if (messages.length <= keepRecent + 2) {
    // Not enough messages to compact
    return {
      messages,
      tokensSaved: 0,
      wasCompacted: false,
      method: 'none',
    };
  }

  const originalTokens = estimateMessageTokensArray(messages);
  const compacted: ChatMessage[] = [];

  // Keep the most recent messages
  const messagesToKeep = messages.slice(-keepRecent - 2); // Keep system + recent conversation

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
            output: TIME_BASED_MC_CLEARED_MESSAGE,
          })),
        });
      } else {
        compacted.push(msg);
      }
    } else if (msg.role === 'assistant' && msg.toolCalls) {
      compacted.push(msg);
    } else {
      compacted.push(msg);
    }
  }

  // Add recent messages unchanged
  compacted.push(...messagesToKeep);

  // Calculate tokens saved without re-estimating original messages
  const compactedTokens = estimateMessageTokensArray(compacted);
  const tokensSaved = originalTokens - compactedTokens;

  return {
    messages: compacted,
    tokensSaved,
    wasCompacted: tokensSaved > 0,
    method: tokensSaved > 0 ? 'microcompact' : 'none',
  };
}

/**
 * Full compact: LLM-based conversation summarization.
 * This requires calling the LLM API to generate a summary.
 */
export async function fullCompact(
  messages: ChatMessage[],
  apiClient: import('../api/BaseApiClient').BaseApiClient,
  config: CompactConfig,
  systemPrompt: string = ''
): Promise<CompactionResult> {
  if (messages.length <= PRESERVE_RECENT + 2) {
    return {
      messages,
      tokensSaved: 0,
      wasCompacted: false,
      method: 'none',
    };
  }

  try {
    // Step 1: Try microcompact first (cheap)
    const microResult = microcompact(messages);
    if (microResult.wasCompacted) {
      const threshold = config.contextWindow - MAX_OUTPUT_TOKENS_FOR_SUMMARY - AUTOCOMPACT_BUFFER_TOKENS;
      const remainingTokens = estimateMessageTokensArray(microResult.messages);

      if (remainingTokens < threshold) {
        return microResult;
      }
    }

    // Step 2: Full LLM-based compaction
    // Split messages into old (to summarize) and recent (to preserve)
    const oldMessages = messages.slice(0, -PRESERVE_RECENT);
    const recentMessages = messages.slice(-PRESERVE_RECENT);

    // Build summary prompt
    const summaryPrompt = buildCompactPrompt(oldMessages, systemPrompt);

    // Call LLM to generate summary (no tools)
    let summaryResponse: string;
    try {
      const response = await apiClient.chat({
        model: config.model,
        messages: [{
          id: `summary_${Date.now()}`,
          role: 'user',
          content: summaryPrompt,
          timestamp: Date.now(),
        }],
        maxTokens: 1024,
        temperature: 0.3,
        stream: false,
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
      method: 'fullcompact',
    };
  } catch (error) {
    // Return original messages on error
    return {
      messages,
      tokensSaved: 0,
      wasCompacted: false,
      method: 'none',
    };
  }
}

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
 * Format compact summary from LLM response
 * Extracts content from <summary> tags if present
 */
export function needsForceTruncation(messages: ChatMessage[]): boolean {
  // Primary check: token-based limit
  try {
    const tokenCount = estimateMessageTokensArray(messages);
    if (tokenCount > MAX_TOKEN_LIMIT) return true;
  } catch {
    // Fall through to message count check if token estimation fails
  }
  // Fallback: message count limit
  return messages.length > MAX_MESSAGE_COUNT;
}

export function forceTruncate(messages: ChatMessage[]): { messages: ChatMessage[]; tokensSaved: number; wasCompacted: boolean } {
  // Truncate to half the token limit
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
    wasCompacted: tokensSaved > 0,
  };
}

export function getCompactionStrategy(
  _messageCount: number,
  _contextWindow: number
): 'none' | 'micro' | 'full' {
  return _messageCount > 100 ? 'full' : _messageCount > 50 ? 'micro' : 'none';
}

export function formatCompactSummary(rawSummary: string): string {
  // Extract content from <summary> tags if present
  const summaryMatch = rawSummary.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    return summaryMatch[1].trim();
  }

  // Otherwise return as-is
  return rawSummary.trim();
}

/**
 * Build a fallback summary when LLM API is unavailable
 * Simple truncation-based summary
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
