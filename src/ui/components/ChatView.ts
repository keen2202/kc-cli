import chalk from 'chalk';
import { renderToolCallCard, type ToolCallData } from './ToolCallCard';
import { renderThinkingChain, type ThinkingChain } from './ThinkingChainView';
import { renderMarkdown } from './MarkdownRenderer';
import type { Theme, ThemeTokens } from '../theme';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  timestamp: number;
  toolCalls?: ToolCallData[];
}

/**
 * @deprecated Legacy string renderer. The live UI renders chat via the ink
 * `ChatMessagesView` component; this remains only for the existing string-
 * render unit tests and has no production callers. Do not use in new code.
 */
export function renderChatMessage(
  msg: ChatMessage,
  theme?: Theme,
  thinkingChain?: ThinkingChain,
): string {
  const tokens = theme?.resolve();
  const lines: string[] = [];

  if (msg.role === 'user') {
    const prefix = tokens ? tokens['chat.user']('> ') : chalk.cyan.bold('> ');
    if (msg.content) {
      const mdLines = renderMarkdown(msg.content, theme);
      lines.push(prefix + mdLines.join('\n'));
    } else {
      lines.push(prefix);
    }
  } else if (msg.role === 'assistant') {
    // Render thinking chain above assistant content
    if (thinkingChain && tokens) {
      lines.push(renderThinkingChain(thinkingChain, tokens));
    }
    if (msg.content) {
      const mdLines = renderMarkdown(msg.content, theme);
      lines.push(mdLines.join('\n'));
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        lines.push(renderToolCallCard(tc, theme));
      }
    }
  } else if (msg.role === 'system') {
    if (msg.content) {
      const color = tokens ? tokens['chat.system'] : chalk.gray.dim;
      lines.push(color(msg.content));
    }
  }

  return lines.join('\n');
}

/**
 * @deprecated Legacy string renderer with no production callers (superseded by
 * the ink `ChatMessagesView`). Retained only for existing unit tests.
 */
export function renderChatView(
  messages: ChatMessage[],
  theme?: Theme,
  thinkingChains?: Map<string, ThinkingChain>,
): string {
  return messages.map(m =>
    renderChatMessage(m, theme, thinkingChains?.get(m.id)),
  ).join('\n');
}
