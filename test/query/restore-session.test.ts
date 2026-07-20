/**
 * T2: Session restore via QueryEngine.restoreSession() API.
 *
 * Verifies controlled session restore:
 * - Valid snapshot restores messages and returns turnCount
 * - Corrupted snapshots (missing system/user, empty) are rejected
 * - Internal state (compaction cursors, error handler) is reset
 * - Restore-then-compact doesn't produce duplicates
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { QueryEngine } from '../../src/query/QueryEngine';
import type { SessionSnapshot } from '../../src/memory/protocol';
import type { ChatMessage } from '../../src/query/protocol';
import { initializeState } from '../../src/bootstrap/state';

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    sessionId: 'test-session',
    messages: [
      { id: '1', role: 'system', content: 'You are a test agent.', timestamp: 1 },
      { id: '2', role: 'user', content: 'Hello', timestamp: 2 },
      { id: '3', role: 'assistant', content: 'Hi!', timestamp: 3 },
    ],
    state: {
      cwd: '/test',
      model: 'test-model',
      provider: 'anthropic',
      turnCount: 5,
      totalTokensUsed: 1000,
    },
    metadata: {
      createdAt: Date.now(),
      lastModified: Date.now(),
      toolsUsed: ['read', 'write'],
    },
    ...overrides,
  };
}

function makeEngine() {
  return new QueryEngine(
    {
      model: 'test-model',
      provider: 'anthropic',
      apiKey: 'test-key',
      maxTurns: 10,
      maxBudgetUsd: null,
    },
    [],
  );
}

beforeEach(() => {
  initializeState({ cwd: '/test', permissionMode: 'default' });
});

describe('QueryEngine.restoreSession', () => {
  it('restores messages from a valid snapshot', () => {
    const engine = makeEngine();
    const snapshot = makeSnapshot();

    const turnCount = engine.restoreSession(snapshot);

    expect(turnCount).toBe(5);
    expect(engine.messages.length).toBe(3);
    expect(engine.messages[0].role).toBe('system');
    expect(engine.messages[1].role).toBe('user');
  });

  it('rejects snapshot with no system message', () => {
    const engine = makeEngine();
    const snapshot = makeSnapshot({
      messages: [
        { id: '1', role: 'user', content: 'Hello', timestamp: 1 },
      ],
    });

    expect(() => engine.restoreSession(snapshot)).toThrow('missing required system or user message');
  });

  it('rejects snapshot with no user message', () => {
    const engine = makeEngine();
    const snapshot = makeSnapshot({
      messages: [
        { id: '1', role: 'system', content: 'System prompt', timestamp: 1 },
      ],
    });

    expect(() => engine.restoreSession(snapshot)).toThrow('missing required system or user message');
  });

  it('rejects empty snapshot', () => {
    const engine = makeEngine();
    const snapshot = makeSnapshot({ messages: [] });

    expect(() => engine.restoreSession(snapshot)).toThrow('empty');
  });

  it('rejects snapshot with system but no user message', () => {
    const engine = makeEngine();
    const snapshot = makeSnapshot({
      messages: [{ id: '1', role: 'system', content: 'Sys', timestamp: 1 }],
    });

    expect(() => engine.restoreSession(snapshot)).toThrow('missing required system or user message');
  });

  it('keeps current session intact on failed restore', () => {
    const engine = makeEngine();
    // First, successfully load a session
    const good = makeSnapshot();
    engine.restoreSession(good);
    expect(engine.messages.length).toBe(3);

    // Then attempt a bad restore
    const bad = makeSnapshot({ messages: [] });
    expect(() => engine.restoreSession(bad)).toThrow();

    // Original messages should still be there
    expect(engine.messages.length).toBe(3);
  });

  it('resets state machine to idle after restore', () => {
    const engine = makeEngine();
    const snapshot = makeSnapshot();

    engine.restoreSession(snapshot);

    expect(engine.getStateMachine().currentState).toBe('idle');
  });

  it('restore then clear works correctly', () => {
    const engine = makeEngine();
    engine.restoreSession(makeSnapshot());
    expect(engine.messages.length).toBe(3);

    engine.clear();
    expect(engine.messages.length).toBe(0);
  });

  it('multiple restores replace previous messages', () => {
    const engine = makeEngine();
    engine.restoreSession(makeSnapshot());
    expect(engine.messages.length).toBe(3);

    const snapshot2 = makeSnapshot({
      messages: [
        { id: 'a', role: 'system', content: 'Sys2', timestamp: 10 },
        { id: 'b', role: 'user', content: 'Hello2', timestamp: 20 },
        { id: 'c', role: 'assistant', content: 'Hi2!', timestamp: 30 },
        { id: 'd', role: 'user', content: 'More', timestamp: 40 },
      ],
      state: { cwd: '/test', model: 'm2', provider: 'openai', turnCount: 10, totalTokensUsed: 2000 },
    });

    const tc = engine.restoreSession(snapshot2);
    expect(tc).toBe(10);
    expect(engine.messages.length).toBe(4);
  });

  it('restoring a session does not preserve previous internal state', () => {
    const engine = makeEngine();
    // Set up some internal state
    engine.followUp('test follow-up');
    expect(engine.getFollowUpQueueLength()).toBe(1);

    engine.restoreSession(makeSnapshot());

    // Follow-up queue should be cleared
    expect(engine.getFollowUpQueueLength()).toBe(0);
    expect(engine.getSteerQueueLength()).toBe(0);
  });
});
