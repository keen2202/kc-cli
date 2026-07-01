import React from 'react';
import { Box, Text } from 'ink';
import type { ChatMessage } from './ChatView';
import type { ThinkingChain } from './ThinkingChainView';
import { renderThinkingChain } from './ThinkingChainView';
import { renderToolCallCard } from './ToolCallCard';
import { renderMarkdown } from './MarkdownRenderer';
import { useTheme } from '../hooks/useTheme';

interface ChatMessageViewProps {
  message: ChatMessage;
  thinkingChain?: ThinkingChain;
}

export function ChatMessageView({ message, thinkingChain }: ChatMessageViewProps) {
  const { tokens } = useTheme();

  if (message.role === 'user') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          {tokens['chat.user']('▸ ')}
          {message.content ? <Text>{message.content}</Text> : null}
        </Text>
      </Box>
    );
  }

  if (message.role === 'assistant') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        {thinkingChain && (
          <Text>{renderThinkingChain(thinkingChain, tokens)}</Text>
        )}
        {message.content && (
          <Text>{message.content}</Text>
        )}
        {message.toolCalls?.map((tc, i) => (
          <Text key={i}>{renderToolCallCard(tc)}</Text>
        ))}
      </Box>
    );
  }

  // system message
  return (
    <Box marginBottom={1}>
      <Text dimColor>{message.content || ''}</Text>
    </Box>
  );
}

interface ChatViewProps {
  messages: ChatMessage[];
  thinkingChains?: Map<string, ThinkingChain>;
}

export function ChatView({ messages, thinkingChains }: ChatViewProps) {
  return (
    <Box flexDirection="column">
      {messages.map((msg) => (
        <ChatMessageView
          key={msg.id}
          message={msg}
          thinkingChain={thinkingChains?.get(msg.id)}
        />
      ))}
    </Box>
  );
}
