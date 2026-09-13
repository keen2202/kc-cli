/**
 * T6-B6 — branch/checkout token total cache.
 */
import { describe, it, expect } from 'vitest';
import { ConversationState } from '../../src/query/QueryEngineState';
import type { ChatMessage } from '../../src/query/protocol';

function msg(content: string): ChatMessage {
  return { role: 'user', content } as ChatMessage;
}

describe('T6-B6 branch/checkout token cache', () => {
  it('checkout restores a previously computed path total without drift', () => {
    const state = new ConversationState();
    state.addMessage(msg('hello world one'));
    state.addMessage(msg('hello world two'));
    const rootId = state.getSessionTree().getActiveNodeId();
    const rootTotal = state.getTokenEstimate();

    const branchId = state.branch();
    state.addMessage(msg('branch only message'));
    const branchTotal = state.getTokenEstimate();
    expect(branchTotal).toBeGreaterThan(rootTotal);

    state.checkout(rootId);
    expect(state.getTokenEstimate()).toBe(rootTotal);

    state.checkout(branchId);
    expect(state.getTokenEstimate()).toBe(branchTotal);

    // Re-checkout is stable
    state.checkout(rootId);
    expect(state.getTokenEstimate()).toBe(rootTotal);
    state.checkout(branchId);
    expect(state.getTokenEstimate()).toBe(branchTotal);
  });

  it('mutating after checkout updates the cache for that node', () => {
    const state = new ConversationState();
    state.addMessage(msg('root message'));
    const rootId = state.getSessionTree().getActiveNodeId();
    const before = state.getTokenEstimate();

    const branchId = state.branch();
    state.checkout(rootId);
    state.addMessage(msg('extra root message'));
    const after = state.getTokenEstimate();
    expect(after).toBeGreaterThan(before);

    state.checkout(branchId);
    state.checkout(rootId);
    expect(state.getTokenEstimate()).toBe(after);
  });
});
