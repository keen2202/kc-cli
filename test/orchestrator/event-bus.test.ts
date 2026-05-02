import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, ScopedEventBus, eventsForAgent } from '../../src/orchestrator/event-bus';
import type { AgentEvent } from '../../src/state/types';

function makeEvent(text: string): AgentEvent {
  return { type: 'agent:text_delta', text, timestamp: Date.now() };
}

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('should emit events to subscribed handlers', () => {
    const handler = vi.fn();
    bus.on('agent1', handler);
    const event = makeEvent('hello');
    bus.emit('agent1', event);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('should not call handlers for different agents', () => {
    const handler = vi.fn();
    bus.on('agent1', handler);
    bus.emit('agent2', makeEvent('hello'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should support multiple handlers for same agent', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('agent1', handler1);
    bus.on('agent1', handler2);
    bus.emit('agent1', makeEvent('hello'));
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should unsubscribe handler', () => {
    const handler = vi.fn();
    const unsub = bus.on('agent1', handler);
    unsub();
    bus.emit('agent1', makeEvent('hello'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should support once handler', () => {
    const handler = vi.fn();
    bus.once('agent1', handler);
    bus.emit('agent1', makeEvent('first'));
    bus.emit('agent1', makeEvent('second'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should support off with specific handler', () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    bus.on('agent1', handler1);
    bus.on('agent1', handler2);
    bus.off('agent1', handler1);
    bus.emit('agent1', makeEvent('hello'));
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  it('should support off without handler (remove all for agent)', () => {
    const handler = vi.fn();
    bus.on('agent1', handler);
    bus.off('agent1');
    bus.emit('agent1', makeEvent('hello'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should support onAny handler', () => {
    const handler = vi.fn();
    bus.onAny(handler);
    const event1 = makeEvent('hello');
    const event2 = makeEvent('world');
    bus.emit('agent1', event1);
    bus.emit('agent2', event2);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith('agent1', event1);
    expect(handler).toHaveBeenCalledWith('agent2', event2);
  });

  it('should unsubscribe onAny handler', () => {
    const handler = vi.fn();
    const unsub = bus.onAny(handler);
    unsub();
    bus.emit('agent1', makeEvent('hello'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should drain buffered events', () => {
    bus.emit('agent1', makeEvent('a'));
    bus.emit('agent1', makeEvent('b'));
    const events = bus.drain('agent1');
    expect(events).toHaveLength(2);
    // After drain, buffer should be empty
    expect(bus.drain('agent1')).toHaveLength(0);
  });

  it('should drain returns empty for unknown agent', () => {
    expect(bus.drain('unknown')).toHaveLength(0);
  });

  it('should create scoped event bus', () => {
    const scoped = bus.createScoped('agent1');
    expect(scoped).toBeInstanceOf(ScopedEventBus);
  });

  it('should clear all handlers and buffers', () => {
    const handler = vi.fn();
    bus.on('agent1', handler);
    bus.emit('agent1', makeEvent('before'));
    bus.clear();
    // After clear: handler is removed, buffer is cleared
    bus.emit('agent1', makeEvent('after'));
    expect(handler).toHaveBeenCalledTimes(1); // only before clear (handler removed)
    // The 'after' event was buffered by emit (creates new buffer), so drain returns 1
    expect(bus.drain('agent1')).toHaveLength(1);
    // Second drain returns empty
    expect(bus.drain('agent1')).toHaveLength(0);
  });

  it('should get agent IDs', () => {
    bus.on('agent1', vi.fn());
    bus.on('agent2', vi.fn());
    expect(bus.getAgentIds()).toEqual(['agent1', 'agent2']);
  });

  it('should handle handler errors gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badHandler = vi.fn(() => { throw new Error('handler error'); });
    const goodHandler = vi.fn();
    bus.on('agent1', badHandler);
    bus.on('agent1', goodHandler);
    bus.emit('agent1', makeEvent('hello'));
    expect(goodHandler).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should handle any-handler errors gracefully', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const badHandler = vi.fn(() => { throw new Error('any error'); });
    bus.onAny(badHandler);
    bus.emit('agent1', makeEvent('hello'));
    expect(badHandler).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('should drop oldest event when buffer exceeds MAX_BUFFER_SIZE', () => {
    // The MAX_BUFFER_SIZE is 1000
    for (let i = 0; i < 1002; i++) {
      bus.emit('agent1', makeEvent(`event-${i}`));
    }
    const events = bus.drain('agent1');
    expect(events).toHaveLength(1000);
    // First event should be event-2 (dropped 0 and 1)
    expect((events[0] as any).text).toBe('event-2');
  });
});

describe('ScopedEventBus', () => {
  it('should emit to parent with scoped agentId', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('agent1', handler);
    const scoped = new ScopedEventBus(bus, 'agent1');
    scoped.emit(makeEvent('hello'));
    expect(handler).toHaveBeenCalledWith(makeEvent('hello'));
  });

  it('should subscribe via scoped bus', () => {
    const bus = new EventBus();
    const scoped = new ScopedEventBus(bus, 'agent1');
    const handler = vi.fn();
    const unsub = scoped.on(handler);
    bus.emit('agent1', makeEvent('hello'));
    expect(handler).toHaveBeenCalled();
    unsub();
    bus.emit('agent1', makeEvent('world'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should support once via scoped bus', () => {
    const bus = new EventBus();
    const scoped = new ScopedEventBus(bus, 'agent1');
    const handler = vi.fn();
    scoped.once(handler);
    bus.emit('agent1', makeEvent('first'));
    bus.emit('agent1', makeEvent('second'));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should support off via scoped bus', () => {
    const bus = new EventBus();
    const scoped = new ScopedEventBus(bus, 'agent1');
    const handler = vi.fn();
    scoped.on(handler);
    scoped.off(handler);
    bus.emit('agent1', makeEvent('hello'));
    expect(handler).not.toHaveBeenCalled();
  });

  it('should drain via scoped bus', () => {
    const bus = new EventBus();
    const scoped = new ScopedEventBus(bus, 'agent1');
    bus.emit('agent1', makeEvent('a'));
    const events = scoped.drain();
    expect(events).toHaveLength(1);
  });
});

describe('eventsForAgent', () => {
  it('should yield events as async iterator', async () => {
    const bus = new EventBus();
    const iter = eventsForAgent(bus, 'agent1');

    // Emit after getting iterator
    setTimeout(() => {
      bus.emit('agent1', makeEvent('hello'));
    }, 10);

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect((result.value as any).text).toBe('hello');

    // Cleanup
    await iter.return!();
  });

  it('should queue events when not consumed', async () => {
    const bus = new EventBus();
    const iter = eventsForAgent(bus, 'agent1');

    bus.emit('agent1', makeEvent('a'));
    bus.emit('agent1', makeEvent('b'));

    const r1 = await iter.next();
    const r2 = await iter.next();
    expect((r1.value as any).text).toBe('a');
    expect((r2.value as any).text).toBe('b');

    await iter.return!();
  });

  it('should close on abort signal', async () => {
    const bus = new EventBus();
    const controller = new AbortController();
    const iter = eventsForAgent(bus, 'agent1', controller.signal);

    controller.abort();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  it('should return done after return()', async () => {
    const bus = new EventBus();
    const iter = eventsForAgent(bus, 'agent1');
    await iter.return!();
    const result = await iter.next();
    expect(result.done).toBe(true);
  });
});
