import React from 'react';
import { Box, Text } from 'ink';
import { ChatView, type ChatScrollHandle } from './ChatMessagesView.js';
import type { ChatMessage, ThinkingChain } from '../view-protocol';

interface ChatPanelProps {
  messages: ChatMessage[];
  thinkingChains?: Map<string, ThinkingChain>;
  /** Scroll handle wired to the focus stack's editor base layer. */
  scrollRef?: React.MutableRefObject<ChatScrollHandle | null>;
}

export function ChatPanel({ messages, thinkingChains, scrollRef }: ChatPanelProps) {
  if (messages.length === 0) {
    return (
      <Box padding={1} flexDirection="column">
        <Text dimColor>No messages yet. Start a conversation.</Text>
      </Box>
    );
  }

  return (
    <Box padding={1} flexDirection="column">
      <ChatView messages={messages} thinkingChains={thinkingChains} scrollRef={scrollRef} />
    </Box>
  );
}
