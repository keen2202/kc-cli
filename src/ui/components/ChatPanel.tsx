import React from 'react';
import { Box, Text } from 'ink';
import { ChatView, type ChatScrollHandle } from './ChatMessagesView.js';
import type { ChatMessage, ThinkingChain } from '../view-protocol';

interface ChatPanelProps {
  messages: ChatMessage[];
  thinkingChains?: Map<string, ThinkingChain>;
  /** Scroll handle wired to the focus stack's editor base layer. */
  scrollRef?: React.MutableRefObject<ChatScrollHandle | null>;
  /** Global tool-output expansion toggle (Ctrl+O). */
  toolOutputExpanded?: boolean;
  /** Wall-clock tick driving live spinner/elapsed on running tool cards. */
  now?: number;
}

export function ChatPanel({ messages, thinkingChains, scrollRef, toolOutputExpanded, now }: ChatPanelProps) {
  if (messages.length === 0) {
    return (
      <Box padding={1} flexDirection="column">
        <Text dimColor>No messages yet. Start a conversation.</Text>
      </Box>
    );
  }

  return (
    // flexGrow fills the Layout slot's row axis; without it this column box
    // hugs its content width and ChatView's self-measure collapses to a few
    // columns (feedback loop: narrow measure → narrow wrap → narrow measure).
    <Box padding={1} flexDirection="column" flexGrow={1}>
      <ChatView
        messages={messages}
        thinkingChains={thinkingChains}
        scrollRef={scrollRef}
        toolOutputExpanded={toolOutputExpanded}
        now={now}
      />
    </Box>
  );
}
