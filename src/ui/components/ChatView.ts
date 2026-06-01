import chalk from 'chalk';
import { renderToolCallCard, type ToolCallData } from './ToolCallCard';
import type { Theme, ThemeTokens } from '../theme';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  timestamp: number;
  toolCalls?: ToolCallData[];
}

export function renderChatMessage(msg: ChatMessage, theme?: Theme): string {
  const tokens = theme?.resolve();
  const lines: string[] = [];

  if (msg.role === 'user') {
    const prefix = tokens ? tokens['chat.user']('> ') : chalk.cyan.bold('> ');
    lines.push(prefix + msg.content);
  } else if (msg.role === 'assistant') {
    if (msg.content) {
      lines.push(msg.content);
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

export function renderChatView(messages: ChatMessage[], theme?: Theme): string {
  return messages.map(m => renderChatMessage(m, theme)).join('\n');
}
