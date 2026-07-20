// Tests for engineMessagesToUiMessages — mapping engine conversation messages
// (query/protocol) onto the UI ChatMessage shape used by the chat view when a
// persisted session is loaded via /session.

import { describe, it, expect } from 'vitest';
import { engineMessagesToUiMessages } from '../../src/ui/session-mapper';
import type { ChatMessage as EngineChatMessage } from '../../src/query/protocol';

describe('engineMessagesToUiMessages', () => {
  it('maps user/assistant/system messages preserving id, role, content and timestamp', () => {
    const engine: EngineChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'hi there', timestamp: 2 },
      { id: 's1', role: 'system', content: 'note', timestamp: 3 },
    ];
    const ui = engineMessagesToUiMessages(engine);
    expect(ui).toEqual([
      { id: 'u1', role: 'user', content: 'hello', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'hi there', timestamp: 2 },
      { id: 's1', role: 'system', content: 'note', timestamp: 3 },
    ]);
  });

  it('drops tool-role messages (their results surface via assistant tool calls)', () => {
    const engine: EngineChatMessage[] = [
      { id: 'a1', role: 'assistant', content: null, timestamp: 1 },
      { id: 't1', role: 'tool', content: null, timestamp: 2, toolResults: [] } as any,
    ];
    const ui = engineMessagesToUiMessages(engine);
    expect(ui.map((m) => m.id)).toEqual(['a1']);
  });

  it('maps tool calls, serializing input and collapsing pending to running', () => {
    const engine: EngineChatMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: null,
        timestamp: 1,
        toolCalls: [
          { id: 'c1', toolName: 'write_file', input: { path: 'a.ts' }, status: 'completed' },
          { id: 'c2', toolName: 'bash', input: { cmd: 'ls' }, status: 'pending' },
        ],
      } as any,
    ];
    const ui = engineMessagesToUiMessages(engine);
    expect(ui[0]!.toolCalls).toEqual([
      { toolName: 'write_file', status: 'completed', input: JSON.stringify({ path: 'a.ts' }) },
      { toolName: 'bash', status: 'running', input: JSON.stringify({ cmd: 'ls' }) },
    ]);
  });

  it('omits toolCalls when a message has none, and normalizes null content', () => {
    const engine: EngineChatMessage[] = [
      { id: 'a1', role: 'assistant', content: null, timestamp: 1, toolCalls: [] } as any,
    ];
    const ui = engineMessagesToUiMessages(engine);
    expect(ui[0]!.content).toBeNull();
    expect('toolCalls' in ui[0]!).toBe(false);
  });
});
