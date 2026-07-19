import React, { useRef, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ChatMessage } from './ChatView';
import type { ThinkingChain } from './ThinkingChainView';
import { renderThinkingChain } from './ThinkingChainView';
import { renderToolCallCard } from './ToolCallCard';
import { renderMarkdown } from './MarkdownRenderer';
import { useTheme } from '../hooks/useTheme';
import { useVirtualScroll } from '../hooks/useVirtualScroll';

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
          <Box flexDirection="column">
            {renderMarkdown(message.content).map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
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
  isModalOpen?: boolean;
}

export function ChatView({ messages, thinkingChains, isModalOpen }: ChatViewProps) {
  const {
    start,
    end,
    scrollOffset,
    scrollDown,
    scrollUp,
    scrollTo,
    isAtEnd,
    isAtStart,
    pageSize,
  } = useVirtualScroll({
    totalItems: messages.length,
    itemHeight: 3,
    buffer: 10,
  });

  // Auto-scroll to show the latest message when new ones arrive
  const prevLengthRef = useRef(messages.length);
  useEffect(() => {
    if (messages.length > prevLengthRef.current && isAtEnd) {
      scrollTo(messages.length - 1);
    }
    prevLengthRef.current = messages.length;
  }, [messages.length, scrollTo, isAtEnd]);

  // Handle arrow keys for scrolling through messages
  useInput((_input: string, key: { upArrow?: boolean; downArrow?: boolean }) => {
    // When a modal/overlay is open, focus belongs to it: don't scroll the
    // background chat behind the dialog.
    if (isModalOpen) return;
    if (key.upArrow) {
      scrollUp();
    }
    if (key.downArrow) {
      scrollDown();
    }
  });

  const safeEnd = Math.max(start, end);
  const needsScrolling = messages.length > pageSize + 5;

  // When there are few messages, render all without virtual scrolling
  if (!needsScrolling) {
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

  return (
    <Box flexDirection="column">
      {/* Scroll indicator: top */}
      {!isAtStart && messages.length > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>
            {'↑'} Scroll up ({scrollOffset} more) { '—' } use { '↑' }/{ '↓' } to scroll
          </Text>
        </Box>
      )}

      {messages.slice(start, safeEnd).map((msg) => (
        <ChatMessageView
          key={msg.id}
          message={msg}
          thinkingChain={thinkingChains?.get(msg.id)}
        />
      ))}

      {/* Scroll indicator: bottom */}
      {!isAtEnd && messages.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>
            {'↓'} Scroll down ({messages.length - end > 0 ? messages.length - end : 0} more)
          </Text>
        </Box>
      )}
    </Box>
  );
}
