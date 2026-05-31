import { describe, it, expect } from 'vitest';
import type { LLMStreamEvent } from '../../src/api/BaseApiClient';
import type { AgentEvent } from '../../src/types/events';
import { KCError } from '../../src/types/errors';

describe('LLMStreamEvent expanded types', () => {
  it('should accept all new type values', () => {
    const thinkingEvent: LLMStreamEvent = {
      type: 'thinking_delta',
      thinking: 'Let me think about this...',
    };
    expect(thinkingEvent.type).toBe('thinking_delta');
    expect(thinkingEvent.thinking).toBe('Let me think about this...');

    const usageEvent: LLMStreamEvent = {
      type: 'usage_update',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
    expect(usageEvent.type).toBe('usage_update');
    expect(usageEvent.usage?.totalTokens).toBe(150);

    const cacheEvent: LLMStreamEvent = {
      type: 'cache_status',
      cacheHit: true,
    };
    expect(cacheEvent.type).toBe('cache_status');
    expect(cacheEvent.cacheHit).toBe(true);

    const modelEvent: LLMStreamEvent = {
      type: 'model_info',
      model: 'claude-sonnet-4-20250514',
    };
    expect(modelEvent.type).toBe('model_info');
    expect(modelEvent.model).toBe('claude-sonnet-4-20250514');
  });

  it('should still accept original type values', () => {
    const textEvent: LLMStreamEvent = { type: 'text_delta', text: 'hello' };
    expect(textEvent.type).toBe('text_delta');

    const stopEvent: LLMStreamEvent = { type: 'stop' };
    expect(stopEvent.type).toBe('stop');

    const errorEvent: LLMStreamEvent = { type: 'error', error: new Error('test') };
    expect(errorEvent.type).toBe('error');
  });

  it('should allow optional fields to be undefined', () => {
    const event: LLMStreamEvent = { type: 'thinking_delta' };
    expect(event.thinking).toBeUndefined();
    expect(event.cacheHit).toBeUndefined();
    expect(event.model).toBeUndefined();
  });
});

describe('AgentEvent new discriminated union members', () => {
  it('should accept agent:thinking_delta event', () => {
    const event: AgentEvent = {
      type: 'agent:thinking_delta',
      thinking: 'reasoning step',
      timestamp: Date.now(),
    };
    expect(event.type).toBe('agent:thinking_delta');
    if (event.type === 'agent:thinking_delta') {
      expect(event.thinking).toBe('reasoning step');
      expect(typeof event.timestamp).toBe('number');
    }
  });

  it('should accept agent:cache_status event', () => {
    const hitEvent: AgentEvent = {
      type: 'agent:cache_status',
      hit: true,
      timestamp: Date.now(),
    };
    expect(hitEvent.type).toBe('agent:cache_status');
    if (hitEvent.type === 'agent:cache_status') {
      expect(hitEvent.hit).toBe(true);
    }

    const missEvent: AgentEvent = {
      type: 'agent:cache_status',
      hit: false,
      timestamp: Date.now(),
    };
    if (missEvent.type === 'agent:cache_status') {
      expect(missEvent.hit).toBe(false);
    }
  });

  it('should preserve existing AgentEvent types', () => {
    const textDelta: AgentEvent = {
      type: 'agent:text_delta',
      text: 'hello',
      timestamp: Date.now(),
    };
    expect(textDelta.type).toBe('agent:text_delta');

    const complete: AgentEvent = {
      type: 'agent:complete',
      timestamp: Date.now(),
    };
    expect(complete.type).toBe('agent:complete');

    const error: AgentEvent = {
      type: 'agent:error',
      error: new KCError('unknown', 'test'),
      recoverable: true,
      timestamp: Date.now(),
    };
    expect(error.type).toBe('agent:error');
  });

  it('should support discriminated union narrowing for new types', () => {
    const events: AgentEvent[] = [
      { type: 'agent:thinking_delta', thinking: 'step 1', timestamp: 1 },
      { type: 'agent:cache_status', hit: true, timestamp: 2 },
      { type: 'agent:text_delta', text: 'output', timestamp: 3 },
    ];

    const thinkingEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'agent:thinking_delta' }> =>
        e.type === 'agent:thinking_delta'
    );
    expect(thinkingEvents).toHaveLength(1);
    expect(thinkingEvents[0].thinking).toBe('step 1');

    const cacheEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: 'agent:cache_status' }> =>
        e.type === 'agent:cache_status'
    );
    expect(cacheEvents).toHaveLength(1);
    expect(cacheEvents[0].hit).toBe(true);
  });
});

describe('thinking_delta event handling', () => {
  it('should map thinking_delta LLMStreamEvent to agent:thinking_delta AgentEvent', () => {
    // Simulate the mapping logic from QueryEngine.streamLLMResponse
    const llmEvent: LLMStreamEvent = {
      type: 'thinking_delta',
      thinking: 'Let me analyze this code...',
    };

    // The mapping that QueryEngine performs
    let agentEvent: AgentEvent | null = null;
    if (llmEvent.type === 'thinking_delta' && llmEvent.thinking) {
      agentEvent = {
        type: 'agent:thinking_delta',
        thinking: llmEvent.thinking,
        timestamp: Date.now(),
      };
    }

    expect(agentEvent).not.toBeNull();
    expect(agentEvent!.type).toBe('agent:thinking_delta');
    if (agentEvent!.type === 'agent:thinking_delta') {
      expect(agentEvent!.thinking).toBe('Let me analyze this code...');
    }
  });

  it('should map cache_status LLMStreamEvent to agent:cache_status AgentEvent', () => {
    const llmEvent: LLMStreamEvent = {
      type: 'cache_status',
      cacheHit: true,
    };

    let agentEvent: AgentEvent | null = null;
    if (llmEvent.type === 'cache_status') {
      agentEvent = {
        type: 'agent:cache_status',
        hit: llmEvent.cacheHit ?? false,
        timestamp: Date.now(),
      };
    }

    expect(agentEvent).not.toBeNull();
    if (agentEvent!.type === 'agent:cache_status') {
      expect(agentEvent!.hit).toBe(true);
    }
  });

  it('should default cacheHit to false when undefined', () => {
    const llmEvent: LLMStreamEvent = {
      type: 'cache_status',
    };

    const hit = llmEvent.cacheHit ?? false;
    expect(hit).toBe(false);
  });
});
