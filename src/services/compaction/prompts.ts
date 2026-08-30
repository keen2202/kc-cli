// Shared compaction prompt builders — round4 §6-M2 (T27)
//
// full.ts and functional.ts carried near-identical copies of these builders
// and had already diverged: only the functional engine appended the
// modified-files preservation block. One shared implementation now serves
// both; the enhancement is available to either engine via the optional
// `modifiedFiles` parameter.

import type { ChatMessage } from '../../query/protocol';

/** Format the conversation as text for the summarization prompt. */
function formatConversation(messagesToSummarize: ChatMessage[]): string {
  return messagesToSummarize
    .map(msg => {
      const role = msg.role.toUpperCase();
      const content = msg.content || '[tool calls/results]';
      return `${role}: ${content}`;
    })
    .join('\n\n');
}

/**
 * Build the prompt for LLM-based conversation summarization.
 * Pass `modifiedFiles` to make the model explicitly preserve the list of
 * files touched during the session (the functional engine's enhancement).
 */
export function buildSummaryPrompt(
  messagesToSummarize: ChatMessage[],
  systemPrompt: string,
  modifiedFiles?: string[],
): string {
  const conversationText = formatConversation(messagesToSummarize);

  let prompt = `Please summarize the following conversation concisely, preserving key information, decisions, and context that would be needed for future turns. Focus on what was accomplished and what is still pending.

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

  // Append modified files list for explicit preservation
  if (modifiedFiles && modifiedFiles.length > 0) {
    const fileList = modifiedFiles.map(f => `- ${f}`).join('\n');
    prompt += `\n\nIMPORTANT: The following files were modified during this session. Ensure they are explicitly listed in your summary:\n${fileList}`;
  }

  return prompt;
}

/**
 * Build a fallback summary when LLM API is unavailable.
 * Simple truncation-based summary.
 */
export function buildFallbackSummary(messages: ChatMessage[]): string {
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
