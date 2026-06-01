import { describe, it, expect, vi } from 'vitest';
import { UIEventBus } from '../../src/ui/event-bus';
import { createLogMiddleware } from '../../src/ui/middleware/log';
import { createBudgetMiddleware } from '../../src/ui/middleware/budget';
import { createPluginMiddleware } from '../../src/ui/middleware/plugin';
import { createBridgeMiddleware } from '../../src/ui/middleware/bridge';

describe('UIEventBus', () => {
  it('should dispatch events to listeners', () => {
    const bus = new UIEventBus();
    const handler = vi.fn();
    bus.on('test', handler);

    bus.emit({ type: 'test', data: 'hello' } as any);
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: 'test', data: 'hello' });
  });

  it('should support wildcard listeners', () => {
    const bus = new UIEventBus();
    const handler = vi.fn();
    bus.on('*', handler);

    bus.emit({ type: 'foo' } as any);
    bus.emit({ type: 'bar' } as any);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('should return unsubscribe function', () => {
    const bus = new UIEventBus();
    const handler = vi.fn();
    const unsub = bus.on('test', handler);

    bus.emit({ type: 'test' } as any);
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    bus.emit({ type: 'test' } as any);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('should run middlewares in order before listeners', () => {
    const bus = new UIEventBus();
    const order: string[] = [];

    bus.use((_event, next) => {
      order.push('mw1');
      next();
    });
    bus.use((_event, next) => {
      order.push('mw2');
      next();
    });
    bus.on('test', () => {
      order.push('listener');
    });

    bus.emit({ type: 'test' } as any);
    expect(order).toEqual(['mw1', 'mw2', 'listener']);
  });

  it('should block event when middleware does not call next', () => {
    const bus = new UIEventBus();
    const handler = vi.fn();

    bus.use((_event, _next) => {
      // Block: don't call next
    });
    bus.on('test', handler);

    bus.emit({ type: 'test' } as any);
    expect(handler).not.toHaveBeenCalled();
  });

  it('should support 3 middlewares with block behavior', () => {
    const bus = new UIEventBus();
    const order: string[] = [];
    const handler = vi.fn();

    bus.use((_event, next) => {
      order.push('log');
      next();
    });
    bus.use((_event, _next) => {
      order.push('block');
      // Don't call next - blocks further processing
    });
    bus.use((_event, next) => {
      order.push('transform');
      next();
    });
    bus.on('test', handler);

    bus.emit({ type: 'test' } as any);
    expect(order).toEqual(['log', 'block']);
    expect(handler).not.toHaveBeenCalled();
  });

  it('clear() should remove all middlewares and listeners', () => {
    const bus = new UIEventBus();
    const handler = vi.fn();

    bus.use((_e, next) => next());
    bus.on('test', handler);
    bus.clear();

    bus.emit({ type: 'test' } as any);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('LogMiddleware', () => {
  it('should log events when verbose is true', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mw = createLogMiddleware(true);

    const next = vi.fn();
    mw({ type: 'test', timestamp: 123 } as any, next);

    expect(next).toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it('should not log when verbose is false', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const mw = createLogMiddleware(false);

    const next = vi.fn();
    mw({ type: 'test', timestamp: 123 } as any, next);

    expect(next).toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });
});

describe('BudgetMiddleware', () => {
  it('should track token usage from turn_complete events', () => {
    const mw = createBudgetMiddleware(1000);
    const next = vi.fn();

    mw({ type: 'agent:turn_complete', usage: { totalTokens: 500 }, timestamp: 1 } as any, next);
    expect(mw.getState().used).toBe(500);
    expect(mw.getState().warned80).toBe(false);

    mw({ type: 'agent:turn_complete', usage: { totalTokens: 300 }, timestamp: 2 } as any, next);
    expect(mw.getState().used).toBe(800);
    expect(mw.getState().warned80).toBe(true); // 80% reached
  });

  it('should block at 100% budget', () => {
    const mw = createBudgetMiddleware(1000);
    const next = vi.fn();

    mw({ type: 'agent:turn_complete', usage: { totalTokens: 1100 }, timestamp: 1 } as any, next);
    expect(mw.getState().blocked).toBe(true);
  });

  it('should reset state', () => {
    const mw = createBudgetMiddleware(1000);
    const next = vi.fn();

    mw({ type: 'agent:turn_complete', usage: { totalTokens: 900 }, timestamp: 1 } as any, next);
    mw.reset();
    expect(mw.getState().used).toBe(0);
    expect(mw.getState().warned80).toBe(false);
    expect(mw.getState().blocked).toBe(false);
  });
});

describe('PluginMiddleware', () => {
  it('should route events to registered plugin hooks', () => {
    const mw = createPluginMiddleware();
    const next = vi.fn();

    const hook = {
      onToolStart: vi.fn(),
      onToolComplete: vi.fn(),
      onTurnComplete: vi.fn(),
      onError: vi.fn(),
      onTextDelta: vi.fn(),
    };
    mw.register(hook);

    mw({ type: 'agent:tool_started', toolCall: { toolName: 'Bash' }, timestamp: 1 } as any, next);
    expect(hook.onToolStart).toHaveBeenCalledWith({ toolName: 'Bash' });

    mw({ type: 'agent:tool_completed', toolCall: { toolName: 'Bash' }, result: { output: 'ok' }, timestamp: 2 } as any, next);
    expect(hook.onToolComplete).toHaveBeenCalledWith({ toolName: 'Bash' }, { output: 'ok' });

    mw({ type: 'agent:text_delta', text: 'hello', timestamp: 3 } as any, next);
    expect(hook.onTextDelta).toHaveBeenCalledWith('hello');

    mw({ type: 'agent:turn_complete', message: {}, usage: {}, timestamp: 4 } as any, next);
    expect(hook.onTurnComplete).toHaveBeenCalledWith({}, {});

    mw({ type: 'agent:error', error: new Error('test'), recoverable: false, timestamp: 5 } as any, next);
    expect(hook.onError).toHaveBeenCalledWith(expect.any(Error), false);
  });
});

describe('BridgeMiddleware', () => {
  it('should not output when disabled', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mw = createBridgeMiddleware();
    const next = vi.fn();

    mw({ type: 'test', timestamp: 1 } as any, next);
    expect(next).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('should output NDJSON when enabled', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const mw = createBridgeMiddleware();
    const next = vi.fn();

    mw.enable();
    expect(mw.isEnabled()).toBe(true);

    mw({ type: 'test', timestamp: 1 } as any, next);
    expect(next).toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalled();

    const output = stdoutSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output.trim());
    expect(parsed.type).toBe('test');
    expect(parsed.payload).toBeDefined();
    expect(parsed.timestamp).toBeDefined();

    stdoutSpy.mockRestore();
  });
});
