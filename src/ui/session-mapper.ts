// Map engine-side conversation messages (query/protocol ChatMessage) onto the
// UI's ChatMessage shape (ui/components/ChatView) so a loaded session can be
// replayed in the chat view. Kept pure and dependency-free for unit testing.

import type { ChatMessage as EngineChatMessage } from '../query/protocol';
import type { ChatMessage as UIChatMessage, ToolCallData } from './view-protocol';

/**
 * Convert engine conversation messages into UI chat messages.
 *
 * - 'tool' role messages are dropped: their results are surfaced through the
 *   originating assistant message's tool calls in the UI, not as standalone rows.
 * - Engine tool-call status 'pending' collapses to 'running' since the UI only
 *   models running/completed/failed.
 */
export function engineMessagesToUiMessages(messages: EngineChatMessage[]): UIChatMessage[] {
  const result: UIChatMessage[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') continue;

    const toolCalls: ToolCallData[] | undefined = msg.toolCalls?.map((tc) => ({
      toolName: tc.toolName,
      status: tc.status === 'completed' || tc.status === 'failed' ? tc.status : 'running',
      input: (() => {
        try {
          return JSON.stringify(tc.input);
        } catch {
          return undefined;
        }
      })(),
    }));

    result.push({
      id: msg.id,
      role: msg.role,
      content: msg.content ?? null,
      timestamp: msg.timestamp,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    });
  }
  return result;
}
