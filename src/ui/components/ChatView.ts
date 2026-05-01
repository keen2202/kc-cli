import chalk from 'chalk';
import { renderToolCallCard, type ToolCallData } from './ToolCallCard';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string | null;
  timestamp: number;
  toolCalls?: ToolCallData[];
}

export function renderChatMessage(msg: ChatMessage): string {
  const lines: string[] = [];

  if (msg.role === 'user') {
    lines.push(chalk.cyan.bold('> ') + msg.content);
  } else if (msg.role === 'assistant') {
    if (msg.content) {
      lines.push(msg.content);
    }
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      for (const tc of msg.toolCalls) {
        lines.push(renderToolCallCard(tc));
      }
    }
  } else if (msg.role === 'system') {
    if (msg.content) {
      lines.push(chalk.gray.dim(msg.content));
    }
  }

  return lines.join('\n');
}

export function renderChatView(messages: ChatMessage[]): string {
  return messages.map(renderChatMessage).join('\n');
}
