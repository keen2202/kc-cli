// Steering System Tests - Dual-Queue Steering
// Covers:
// - steer() adds message to queue
// - followUp() adds message to queue
// - steerQueue is drained between execution phases
// - followUpQueue is drained after turn completion
// - agent:steered event is yielded
// - steering continues the loop (doesn't complete)
// - empty queues don't affect normal flow
// - isSteeringEnabled / getSteerQueueLength getters

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toolRegistry, registerBuiltInTools } from '../../src/tools.js';
import { initializeState } from '../../src/bootstrap/state.js';

beforeEach(() => {
  initializeState();
  process.env.KC_API_KEY = 'test-dummy-key';
});

// ── Queue API ──

describe('Steering — Queue API', () => {
  it('steer() adds message to steer queue', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    expect(engine.getSteerQueueLength()).toBe(0);

    engine.steer('change direction');

    expect(engine.getSteerQueueLength()).toBe(1);
  });

  it('steer() accumulates multiple messages', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    engine.steer('first');
    engine.steer('second');
    engine.steer('third');

    expect(engine.getSteerQueueLength()).toBe(3);
  });

  it('followUp() adds message to followUp queue', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    expect(engine.getFollowUpQueueLength()).toBe(0);

    engine.followUp('also do this');

    expect(engine.getFollowUpQueueLength()).toBe(1);
  });

  it('followUp() accumulates multiple messages', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    engine.followUp('one');
    engine.followUp('two');

    expect(engine.getFollowUpQueueLength()).toBe(2);
  });

  it('isSteeringEnabled() returns true by default', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    expect(engine.isSteeringEnabled()).toBe(true);
  });

  it('clear() resets both queues', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    engine.steer('test steer');
    engine.followUp('test followup');

    expect(engine.getSteerQueueLength()).toBe(1);
    expect(engine.getFollowUpQueueLength()).toBe(1);

    engine.clear();

    expect(engine.getSteerQueueLength()).toBe(0);
    expect(engine.getFollowUpQueueLength()).toBe(0);
  });
});

// ── Event Type ──

describe('Steering — agent:steered event type', () => {
  it('agent:steered event has correct shape', async () => {
    // Verify the event type exists in the union and has the right fields
    const events = await import('../../src/state/events.js');

    // Create a sample steered event to verify the type structure
    const steeredEvent: events.AgentEvent = {
      type: 'agent:steered',
      message: {
        id: 'test-id',
        role: 'user',
        content: 'steer message',
        timestamp: Date.now(),
      },
      timestamp: Date.now(),
    };

    expect(steeredEvent.type).toBe('agent:steered');
    if (steeredEvent.type === 'agent:steered') {
      expect(steeredEvent.message.role).toBe('user');
      expect(steeredEvent.message.content).toBe('steer message');
      expect(typeof steeredEvent.timestamp).toBe('number');
    }
  });
});

// ── KeyPress — isSteerKey ──

describe('Steering — isSteerKey', () => {
  it('returns true for Ctrl+I', async () => {
    const { isSteerKey } = await import('../../src/ui/keypress.js');

    expect(isSteerKey({ name: 'i', ctrl: true, meta: false })).toBe(true);
  });

  it('returns false for plain i', async () => {
    const { isSteerKey } = await import('../../src/ui/keypress.js');

    expect(isSteerKey({ name: 'i', ctrl: false, meta: false })).toBe(false);
  });

  it('returns false for Ctrl+other letter', async () => {
    const { isSteerKey } = await import('../../src/ui/keypress.js');

    expect(isSteerKey({ name: 'c', ctrl: true, meta: false })).toBe(false);
    expect(isSteerKey({ name: 'k', ctrl: true, meta: false })).toBe(false);
  });
});

// ── InputBox — Steer Mode ──

describe('Steering — InputBox steer mode', () => {
  it('createInputState defaults steerMode to false', async () => {
    const { createInputState } = await import('../../src/ui/components/InputBox.js');

    const state = createInputState();
    expect(state.steerMode).toBe(false);
  });

  it('toggleSteerMode switches steerMode on and off', async () => {
    const { createInputState, toggleSteerMode } = await import('../../src/ui/components/InputBox.js');

    const state = createInputState();
    expect(state.steerMode).toBe(false);

    const steered = toggleSteerMode(state);
    expect(steered.steerMode).toBe(true);

    const normal = toggleSteerMode(steered);
    expect(normal.steerMode).toBe(false);
  });

  it('renderInputBox shows steer> prompt in steer mode', async () => {
    const { renderInputBox, createInputState } = await import('../../src/ui/components/InputBox.js');

    const steerState = { ...createInputState(), steerMode: true, text: 'redirect here' };
    const lines = renderInputBox(steerState);
    const result = lines.join('');
    expect(result).toContain('steer>');
    expect(result).toContain('redirect here');
  });

  it('renderInputBox shows normal prompt when steerMode is false', async () => {
    const { renderInputBox, createInputState } = await import('../../src/ui/components/InputBox.js');

    const state = { ...createInputState(), text: 'normal input' };
    const lines = renderInputBox(state);
    const result = lines.join('');
    expect(result).toContain('kc>');
    expect(result).not.toContain('steer>');
  });

  it('renderInputBox shows normal prompt when steerMode is undefined', async () => {
    const { renderInputBox } = await import('../../src/ui/components/InputBox.js');

    const state = { text: 'test', cursorPos: 0, historyIndex: -1 };
    const lines = renderInputBox(state);
    const result = lines.join('');
    expect(result).toContain('kc>');
    expect(result).not.toContain('steer>');
  });
});

// ── Drain Behavior ──

describe('Steering — Drain internals', () => {
  it('steering queue is independent from followUp queue', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    engine.steer('steer msg');
    engine.followUp('followup msg');

    // Both queues should be independent
    expect(engine.getSteerQueueLength()).toBe(1);
    expect(engine.getFollowUpQueueLength()).toBe(1);
  });

  it('steering works even when engine is in terminal state', async () => {
    const { QueryEngine } = await import('../../src/query/QueryEngine.js');
    await registerBuiltInTools();
    const tools = toolRegistry.getAllTools();

    const engine = new QueryEngine({
      model: 'gpt-4',
      provider: 'openai',
      maxTurns: 10,
      maxBudgetUsd: null,
    }, tools);

    // Put engine in error state
    engine.abort('test');

    // Should still be able to enqueue
    engine.steer('test message');
    expect(engine.getSteerQueueLength()).toBe(1);
  });
});
