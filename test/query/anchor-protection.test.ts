import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryEngine } from '../../src/query/QueryEngine';
import { initializeState } from '../../src/bootstrap/state';
import type { ChatMessage } from '../../src/types/message';
import { v4 as uuidv4 } from 'uuid';

// Helper to access private trimMessages method
function callTrimMessages(engine: QueryEngine): void {
  (engine as any).trimMessages();
}

function callSetMessages(engine: QueryEngine, messages: ChatMessage[]): void {
  (engine as any).messages = messages;
}

function callGetMessages(engine: QueryEngine): ChatMessage[] {
  return (engine as any).messages;
}

function makeUserMessage(content: string): ChatMessage {
  return {
    id: uuidv4(),
    role: 'user',
    content,
    timestamp: Date.now(),
  };
}

function makeAssistantMessage(content: string): ChatMessage {
  return {
    id: uuidv4(),
    role: 'assistant',
    content,
    timestamp: Date.now(),
  };
}

function makeSystemMessage(content: string): ChatMessage {
  return {
    id: uuidv4(),
    role: 'system',
    content,
    timestamp: Date.now(),
  };
}

describe('Context Anchor Protection', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    initializeState({ cwd: '/tmp', apiKey: 'test', permissionMode: 'bypassPermissions' as any });
    // Create engine with low maxMessages for testing
    engine = new QueryEngine(
      {
        model: 'test-model',
        provider: 'anthropic',
        apiKey: 'test-key',
        maxTurns: 100,
        maxBudgetUsd: null,
        maxMessages: 5,
      },
      []
    );
  });

  it('should protect system prompt from trimming', () => {
    const systemMsg = makeSystemMessage('You are a helpful assistant');
    const userMsg = makeUserMessage('hello');
    const msgs: ChatMessage[] = [
      systemMsg,
      userMsg,
      makeAssistantMessage('hi'),
      makeUserMessage('question 1'),
      makeAssistantMessage('answer 1'),
      makeUserMessage('question 2'), // 6th message, exceeds limit of 5
    ];

    callSetMessages(engine, msgs);
    callTrimMessages(engine);

    const result = callGetMessages(engine);
    expect(result.length).toBeLessThanOrEqual(5);
    // System message should still be first
    expect(result[0].role).toBe('system');
    expect(result[0].content).toBe('You are a helpful assistant');
  });

  it('should protect first user message from trimming', () => {
    const userMsg = makeUserMessage('original task description');
    const msgs: ChatMessage[] = [
      userMsg,
      makeAssistantMessage('response 1'),
      makeUserMessage('follow up 1'),
      makeAssistantMessage('response 2'),
      makeUserMessage('follow up 2'),
      makeAssistantMessage('response 3'), // 6th message
    ];

    callSetMessages(engine, msgs);
    callTrimMessages(engine);

    const result = callGetMessages(engine);
    expect(result.length).toBeLessThanOrEqual(5);
    // First user message should still be present
    expect(result.some(m => m.content === 'original task description')).toBe(true);
  });

  it('should protect both system and first user message', () => {
    const systemMsg = makeSystemMessage('System prompt');
    const userMsg = makeUserMessage('original task');
    const msgs: ChatMessage[] = [
      systemMsg,
      userMsg,
      makeAssistantMessage('response 1'),
      makeUserMessage('question 1'),
      makeAssistantMessage('answer 1'),
      makeUserMessage('question 2'), // 6th message
    ];

    callSetMessages(engine, msgs);
    callTrimMessages(engine);

    const result = callGetMessages(engine);
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result[0].role).toBe('system');
    expect(result[1].role).toBe('user');
    expect(result[1].content).toBe('original task');
  });

  it('should trim non-anchor messages from oldest first', () => {
    const userMsg = makeUserMessage('original task');
    const msgs: ChatMessage[] = [
      userMsg,
      makeAssistantMessage('response 1'),
      makeUserMessage('question 1'),
      makeAssistantMessage('answer 1'),
      makeUserMessage('question 2'),
      makeAssistantMessage('answer 2'), // 6th message
    ];

    callSetMessages(engine, msgs);
    callTrimMessages(engine);

    const result = callGetMessages(engine);
    expect(result.length).toBe(5);
    // First user message preserved
    expect(result[0].content).toBe('original task');
    // 'response 1' (index 1) should be trimmed as it's the oldest non-anchor
    expect(result.some(m => m.content === 'response 1')).toBe(false);
  });

  it('should not trim when under limit', () => {
    const msgs: ChatMessage[] = [
      makeUserMessage('hello'),
      makeAssistantMessage('hi'),
    ];

    callSetMessages(engine, msgs);
    callTrimMessages(engine);

    const result = callGetMessages(engine);
    expect(result).toHaveLength(2);
  });

  it('should handle messages without anchors (no system or user message)', () => {
    const msgs: ChatMessage[] = [
      makeAssistantMessage('a1'),
      makeAssistantMessage('a2'),
      makeAssistantMessage('a3'),
      makeAssistantMessage('a4'),
      makeAssistantMessage('a5'),
      makeAssistantMessage('a6'), // 6th
    ];

    callSetMessages(engine, msgs);
    callTrimMessages(engine);

    const result = callGetMessages(engine);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});
