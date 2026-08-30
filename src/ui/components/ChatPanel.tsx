import React from 'react';
import { Box, Text } from 'ink';
import { ChatView, type ChatScrollHandle } from './ChatMessagesView.js';
import type { ChatMessage, ThinkingChain, LiveThinkingChain } from '../view-protocol';

interface ChatPanelProps {
  messages: ChatMessage[];
  /** Chains frozen at turn end — stable identity, must not move while streaming. */
  frozenChains?: Map<string, ThinkingChain>;
  /** Chain of the streaming assistant bubble. */
  liveChain?: LiveThinkingChain | null;
  /** Scroll handle wired to the focus stack's editor base layer. */
  scrollRef?: React.MutableRefObject<ChatScrollHandle | null>;
  /** Global tool-output expansion toggle (Ctrl+O). */
  toolOutputExpanded?: boolean;
  /** Whether an engine turn is in flight; drives ChatView's self-scoped tick. */
  isStreaming?: boolean;
}

export function ChatPanel({ messages, frozenChains, liveChain, scrollRef, toolOutputExpanded, isStreaming }: ChatPanelProps) {
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
        frozenChains={frozenChains}
        liveChain={liveChain}
        scrollRef={scrollRef}
        toolOutputExpanded={toolOutputExpanded}
        isStreaming={isStreaming}
      />
    </Box>
  );
}
