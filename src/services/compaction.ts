// Auto-compaction service - manages conversation context window

import type { ChatMessage } from '../types/message';
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
      // Check if this is a compactable tool
      // Try to infer tool name from the associated assistant message's toolCalls
      // Since we can't reliably determine the tool from the result alone,
      // we consider all tool results with output as compactable candidates
      const hasCompactableTool = msg.toolResults.some(result => {
        // Results with substantial output are good compaction candidates
        return result.output && String(result.output).length > 50;
      });

      if (hasCompactableTool) {
        // Replace tool result content with placeholder
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
      // Keep assistant messages with tool calls (they're small)
      compacted.push(msg);
    } else {
      // Keep user messages and system messages
      compacted.push(msg);
    }
  }

  // Add recent messages unchanged
  compacted.push(...messagesToKeep);

  const tokensSaved = calculateTokensSaved(messages, compacted);

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
  apiClient: any, // LLM API client (placeholder type)
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
        // Microcompact was sufficient
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
    // TODO: Integrate with real LLM API client once implemented
    let summaryResponse: string;
    try {
      summaryResponse = await apiClient.generateSummary(summaryPrompt);
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
