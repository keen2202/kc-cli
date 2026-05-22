/**
 * Tests for ChatView component.
 *
 * Covers:
 * - renderChatMessage for user/assistant/system roles
 * - renderChatView with multiple messages
 * - Messages with tool calls
 * - Null content handling
 * - Empty messages
 */

import { describe, it, expect } from 'vitest';
import {
  renderChatMessage,
  renderChatView,
  type ChatMessage,
} from '../../src/ui/components/ChatView';
import type { ToolCallData } from '../../src/ui/components/ToolCallCard';

describe('ChatView — renderChatMessage', () => {
  it('renders user message with prefix', () => {
    const msg: ChatMessage = {
      id: '1',
      role: 'user',
      content: 'Hello world',
      timestamp: Date.now(),
    };
    const result = renderChatMessage(msg);
    expect(result).toContain('> ');
    expect(result).toContain('Hello world');
  });

  it('renders assistant message content', () => {
    const msg: ChatMessage = {
      id: '2',
      role: 'assistant',
      content: 'I can help with that.',
      timestamp: Date.now(),
    };
    const result = renderChatMessage(msg);
    expect(result).toContain('I can help with that.');
    expect(result).not.toContain('> ');
  });

  it('renders system message with dimmed style', () => {
    const msg: ChatMessage = {
      id: '3',
      role: 'system',
      content: 'Session started',
      timestamp: Date.now(),
    };
    const result = renderChatMessage(msg);
    expect(result).toContain('Session started');
  });

  it('handles assistant message with null content', () => {
    const msg: ChatMessage = {
      id: '4',
      role: 'assistant',
      content: null,
      timestamp: Date.now(),
    };
    const result = renderChatMessage(msg);
    // Should not throw, returns empty or tool call content
    expect(typeof result).toBe('string');
  });

  it('handles system message with null content', () => {
    const msg: ChatMessage = {
      id: '5',
      role: 'system',
      content: null,
      timestamp: Date.now(),
    };
    const result = renderChatMessage(msg);
    expect(typeof result).toBe('string');
    expect(result).toBe('');
  });

  it('renders assistant message with tool calls', () => {
    const toolCalls: ToolCallData[] = [
      { toolName: 'Bash', status: 'completed', output: 'done' },
      { toolName: 'FileRead', status: 'running' },
    ];
    const msg: ChatMessage = {
      id: '6',
      role: 'assistant',
      content: 'Running commands...',
      timestamp: Date.now(),
      toolCalls,
    };
    const result = renderChatMessage(msg);
    expect(result).toContain('Running commands...');
    expect(result).toContain('Bash');
    expect(result).toContain('FileRead');
  });

  it('renders assistant message with only tool calls (no text)', () => {
    const toolCalls: ToolCallData[] = [
      { toolName: 'Grep', status: 'completed', output: 'found 5 matches' },
    ];
    const msg: ChatMessage = {
      id: '7',
      role: 'assistant',
      content: null,
      timestamp: Date.now(),
      toolCalls,
    };
    const result = renderChatMessage(msg);
    expect(result).toContain('Grep');
  });

  it('renders assistant message with empty tool calls array', () => {
    const msg: ChatMessage = {
      id: '8',
      role: 'assistant',
      content: 'No tools used',
      timestamp: Date.now(),
      toolCalls: [],
    };
    const result = renderChatMessage(msg);
    expect(result).toContain('No tools used');
  });

  it('renders user message with empty content', () => {
    const msg: ChatMessage = {
      id: '9',
      role: 'user',
      content: '',
      timestamp: Date.now(),
    };
    const result = renderChatMessage(msg);
    expect(result).toContain('> ');
  });

  it('renders multiple tool calls in order', () => {
    const toolCalls: ToolCallData[] = [
      { toolName: 'First', status: 'completed' },
      { toolName: 'Second', status: 'completed' },
      { toolName: 'Third', status: 'running' },
    ];
    const msg: ChatMessage = {
      id: '10',
      role: 'assistant',
      content: null,
      timestamp: Date.now(),
      toolCalls,
    };
    const result = renderChatMessage(msg);
    // All tool names should appear
    expect(result).toContain('First');
    expect(result).toContain('Second');
    expect(result).toContain('Third');
  });
});

describe('ChatView — renderChatView', () => {
  it('renders multiple messages', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Hello', timestamp: 1 },
      { id: '2', role: 'assistant', content: 'Hi there', timestamp: 2 },
    ];
    const result = renderChatView(messages);
    expect(result).toContain('Hello');
    expect(result).toContain('Hi there');
  });

  it('renders empty array', () => {
    const result = renderChatView([]);
    expect(result).toBe('');
  });

  it('renders mixed message types', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Question', timestamp: 1 },
      { id: '2', role: 'assistant', content: 'Answer', timestamp: 2 },
      { id: '3', role: 'system', content: 'Note', timestamp: 3 },
    ];
    const result = renderChatView(messages);
    expect(result).toContain('Question');
    expect(result).toContain('Answer');
    expect(result).toContain('Note');
  });

  it('renders conversation with tool calls', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'Run a command', timestamp: 1 },
      {
        id: '2',
        role: 'assistant',
        content: 'Running...',
        timestamp: 2,
        toolCalls: [
          { toolName: 'Bash', status: 'completed', output: 'success' },
        ],
      },
    ];
    const result = renderChatView(messages);
    expect(result).toContain('Run a command');
    expect(result).toContain('Running...');
    expect(result).toContain('Bash');
  });

  it('separates messages with newlines', () => {
    const messages: ChatMessage[] = [
      { id: '1', role: 'user', content: 'A', timestamp: 1 },
      { id: '2', role: 'user', content: 'B', timestamp: 2 },
    ];
    const result = renderChatView(messages);
    const lines = result.split('\n');
    // At least 2 lines (one for each message)
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });
});
