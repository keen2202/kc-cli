import React from 'react';
import { Box, Text } from 'ink';
import { ChatView } from './ChatMessagesView.js';
import type { ChatMessage } from './ChatView';
import type { ThinkingChain } from './ThinkingChainView';

interface ChatPanelProps {
  messages: ChatMessage[];
  thinkingChains?: Map<string, ThinkingChain>;
  isModalOpen?: boolean;
}

export function ChatPanel({ messages, thinkingChains, isModalOpen }: ChatPanelProps) {
  if (messages.length === 0) {
    return (
      <Box padding={1} flexDirection="column">
        <Text dimColor>No messages yet. Start a conversation.</Text>
      </Box>
    );
  }

  return (
    <Box padding={1} flexDirection="column">
      <ChatView messages={messages} thinkingChains={thinkingChains} isModalOpen={isModalOpen} />
    </Box>
  );
}
