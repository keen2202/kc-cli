import chalk from 'chalk';
import { renderChatView, type ChatMessage } from './ChatView';
import type { Theme } from '../theme';
import type { VirtualScroller } from '../virtual-scroll';

export interface ChatViewportProps {
  messages: ChatMessage[];
  scroller: VirtualScroller;
  width: number;
  height: number;
  theme: Theme;
  virtualScrollThreshold?: number;
}

export function renderChatViewport(props: ChatViewportProps): string[] {
  const { messages, scroller, width, theme } = props;
  const threshold = props.virtualScrollThreshold ?? 100;

  if (messages.length === 0) {
    return [
      chalk.gray.dim('  Ready. What would you like me to do?'),
      chalk.gray.dim('  Type /help for commands, /exit to quit.'),
    ];
  }

  if (messages.length > threshold) {
    scroller.setTotalItems(messages.length);
    scroller.scrollToBottom();
    return scroller.render(
      messages,
      (msg) => renderChatView([msg], theme).split('\n'),
      width,
    );
  }

  return renderChatView(messages, theme).split('\n');
}
