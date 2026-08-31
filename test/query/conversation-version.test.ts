// test/query/conversation-version.test.ts
import { describe, it, expect } from 'vitest';
import { ConversationState } from '../../src/query/QueryEngineState';
import type { ChatMessage } from '../../src/query/protocol';

function msg(role: 'user' | 'assistant', content: string): ChatMessage {
  return { id: `${role}-${Math.random()}`, role, content, timestamp: Date.now() } as ChatMessage;
}

describe('ConversationState version counter', () => {
  it('bumps on addMessage', () => {
    const cs = new ConversationState();
    const v0 = cs.version;
    cs.addMessage(msg('user', 'hi'));
    expect(cs.version).toBe(v0 + 1);
  });

  it('bumps on setMessages', () => {
    const cs = new ConversationState();
    cs.addMessage(msg('user', 'hi'));
    const v0 = cs.version;
    cs.setMessages([msg('user', 'compacted')]);
    expect(cs.version).toBeGreaterThan(v0);
  });

  it('bumps on trim when messages exceed max', () => {
    const cs = new ConversationState({ maxMessages: 2 });
    cs.addMessage(msg('user', 'a'));
    cs.addMessage(msg('assistant', 'b'));
    cs.addMessage(msg('user', 'c'));
    const v0 = cs.version;
    cs.trimIfNeeded();
    expect(cs.version).toBeGreaterThan(v0);
  });

  it('does not bump when trim removes nothing', () => {
    const cs = new ConversationState({ maxMessages: 10 });
    cs.addMessage(msg('user', 'a'));
    const v0 = cs.version;
    cs.trimIfNeeded();
    expect(cs.version).toBe(v0);
  });

  it('bumps on branch, checkout, clear', () => {
    const cs = new ConversationState();
    cs.addMessage(msg('user', 'a'));
    const v0 = cs.version;
    const nodeId = cs.branch();
    expect(cs.version).toBeGreaterThan(v0);
    cs.addMessage(msg('assistant', 'on branch'));
    const v1 = cs.version;
    cs.checkout(nodeId);
    expect(cs.version).toBeGreaterThan(v1);
    const v2 = cs.version;
    cs.clear();
    expect(cs.version).toBeGreaterThan(v2);
  });
});
