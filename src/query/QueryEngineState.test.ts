import { describe, it, expect, vi } from 'vitest';
import { ConversationState } from './QueryEngineState';
import type { ChatMessage } from './protocol';

function makeMsg(id: string, role: 'user' | 'assistant' | 'system', content: string): ChatMessage {
  return { id, role, content, timestamp: Date.now() } as ChatMessage;
}

describe('ConversationState', () => {
  describe('maxMessages default', () => {
    it('default maxMessages is 200', () => {
      const state = new ConversationState();

      // Push 200 messages - should be fine
      for (let i = 0; i < 200; i++) {
        state.addMessage(makeMsg(`msg_${i}`, 'user', `Message ${i}`));
      }
      expect(state.messageCount).toBe(200);

      // Push 201st - no auto-trim, but trimIfNeeded will trim to 200
      state.addMessage(makeMsg('msg_201', 'user', 'Extra'));
      expect(state.messageCount).toBe(201);

      const trimmed = state.trimIfNeeded();
      expect(trimmed).toBe(1);
      expect(state.messageCount).toBe(200);
    });
  });

  describe('incremental token estimate', () => {
    it('getTokenEstimate returns running total without full recomputation', () => {
      const state = new ConversationState();

      // Initial: empty
      expect(state.getTokenEstimate()).toBe(0);

      // Add a message — runningTotal should increase incrementally
      state.addMessage(makeMsg('msg1', 'user', 'Hello'));
      const afterFirst = state.getTokenEstimate();
      expect(afterFirst).toBeGreaterThan(0);

      // Add another message
      state.addMessage(makeMsg('msg2', 'assistant', 'Hi there'));
      const afterSecond = state.getTokenEstimate();
      expect(afterSecond).toBeGreaterThan(afterFirst);
    });
  });
});
