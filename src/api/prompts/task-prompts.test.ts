import { describe, it, expect } from 'vitest';
import { isConversationalMessage, estimateTaskComplexity } from './task-prompts';

describe('isConversationalMessage', () => {
  it('detects Chinese greetings as conversational', () => {
    expect(isConversationalMessage('你好')).toBe(true);
    expect(isConversationalMessage('您好')).toBe(true);
    expect(isConversationalMessage('嗨')).toBe(true);
    expect(isConversationalMessage('早上好')).toBe(true);
  });

  it('detects English greetings as conversational', () => {
    expect(isConversationalMessage('hi')).toBe(true);
    expect(isConversationalMessage('hello')).toBe(true);
    expect(isConversationalMessage('hey')).toBe(true);
    expect(isConversationalMessage('good morning')).toBe(true);
  });

  it('detects capability questions as conversational', () => {
    expect(isConversationalMessage('what can you do')).toBe(true);
    expect(isConversationalMessage('who are you')).toBe(true);
    expect(isConversationalMessage('how are you')).toBe(true);
  });

  it('detects short non-task messages as conversational', () => {
    expect(isConversationalMessage('thanks')).toBe(true);
    expect(isConversationalMessage('ok')).toBe(true);
    expect(isConversationalMessage('cool')).toBe(true);
  });

  it('detects empty/whitespace messages as conversational', () => {
    expect(isConversationalMessage('')).toBe(true);
    expect(isConversationalMessage('   ')).toBe(true);
  });

  it('does NOT detect task-oriented messages as conversational', () => {
    expect(isConversationalMessage('fix the login bug')).toBe(false);
    expect(isConversationalMessage('add a new endpoint for users')).toBe(false);
    expect(isConversationalMessage('create a React component')).toBe(false);
    expect(isConversationalMessage('help me debug the crash in auth.ts')).toBe(false);
    expect(isConversationalMessage('write tests for the API')).toBe(false);
  });
});

describe('estimateTaskComplexity', () => {
  it('returns minimal turns for conversational messages', () => {
    const r = estimateTaskComplexity('你好');
    expect(r.complexity).toBe('simple');
    expect(r.suggestedTurns).toBe(5);
  });

  it('returns minimal turns for English greetings', () => {
    const r = estimateTaskComplexity('hello');
    expect(r.complexity).toBe('simple');
    expect(r.suggestedTurns).toBe(5);
  });

  it('returns default turns for task messages', () => {
    const r = estimateTaskComplexity('fix the login bug in auth.ts');
    expect(r.complexity).toBe('medium');
    expect(r.suggestedTurns).toBe(40);
  });
});
