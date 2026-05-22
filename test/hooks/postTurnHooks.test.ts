import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Import from the module - the hooks array is module-level state, so we need to clear it
import {
  registerPostTurnHook,
  executePostTurnHooks,
  executePostTurnHooksSync,
  getHookCount,
  clearHooks,
} from '../../src/hooks/postTurnHooks';
import type { PostTurnHookContext } from '../../src/hooks/postTurnHooks';

function makeContext(overrides: Partial<PostTurnHookContext> = {}): PostTurnHookContext {
  return {
    messages: [],
    systemPrompt: 'test',
    state: {} as any,
    querySource: 'test',
    ...overrides,
  };
}

beforeEach(() => {
  clearHooks();
  vi.restoreAllMocks();
});

describe('registerPostTurnHook', () => {
  it('adds a hook', () => {
    registerPostTurnHook(vi.fn());
    expect(getHookCount()).toBe(1);
  });

  it('adds multiple hooks', () => {
    registerPostTurnHook(vi.fn());
    registerPostTurnHook(vi.fn());
    registerPostTurnHook(vi.fn());
    expect(getHookCount()).toBe(3);
  });
});

describe('getHookCount', () => {
  it('returns 0 when no hooks registered', () => {
    expect(getHookCount()).toBe(0);
  });

  it('returns correct count after registration', () => {
    registerPostTurnHook(vi.fn());
    expect(getHookCount()).toBe(1);
    registerPostTurnHook(vi.fn());
    expect(getHookCount()).toBe(2);
  });

  it('returns 0 after clearHooks', () => {
    registerPostTurnHook(vi.fn());
    registerPostTurnHook(vi.fn());
    clearHooks();
    expect(getHookCount()).toBe(0);
  });
});

describe('clearHooks', () => {
  it('removes all registered hooks', () => {
    registerPostTurnHook(vi.fn());
    registerPostTurnHook(vi.fn());
    clearHooks();
    expect(getHookCount()).toBe(0);
  });

  it('is safe to call when no hooks registered', () => {
    clearHooks();
    expect(getHookCount()).toBe(0);
  });
});

describe('executePostTurnHooks', () => {
  it('calls all registered hooks', async () => {
    const hook1 = vi.fn().mockResolvedValue(undefined);
    const hook2 = vi.fn().mockResolvedValue(undefined);
    registerPostTurnHook(hook1);
    registerPostTurnHook(hook2);

    const context = makeContext();
    await executePostTurnHooks(context);

    // Fire-and-forget: hooks are invoked via void, so we need a small delay
    await new Promise(r => setTimeout(r, 50));

    expect(hook1).toHaveBeenCalledWith(context);
    expect(hook2).toHaveBeenCalledWith(context);
  });

  it('does not block on hook execution (fire-and-forget)', async () => {
    const slowHook = vi.fn().mockImplementation(
      () => new Promise<void>(r => setTimeout(r, 200))
    );
    registerPostTurnHook(slowHook);

    const start = Date.now();
    await executePostTurnHooks(makeContext());
    const elapsed = Date.now() - start;

    // Should return almost immediately (fire-and-forget)
    expect(elapsed).toBeLessThan(100);
  });

  it('catches errors in hook promises without blocking', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failHook = vi.fn().mockRejectedValue(new Error('hook failed'));
    registerPostTurnHook(failHook);

    await executePostTurnHooks(makeContext());
    await new Promise(r => setTimeout(r, 50));

    expect(consoleSpy).toHaveBeenCalledWith(
      '[PostTurnHook] Error executing hook:',
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it('catches synchronous errors during hook invocation', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncFailHook = vi.fn().mockImplementation(() => {
      throw new Error('sync throw');
    });
    registerPostTurnHook(syncFailHook);

    await executePostTurnHooks(makeContext());

    expect(consoleSpy).toHaveBeenCalledWith(
      '[PostTurnHook] Hook registration error:',
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it('does nothing when no hooks registered', async () => {
    await executePostTurnHooks(makeContext());
    // No error thrown
  });
});

describe('executePostTurnHooksSync', () => {
  it('executes hooks sequentially and waits for completion', async () => {
    const order: number[] = [];
    const hook1 = vi.fn().mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 20));
      order.push(1);
    });
    const hook2 = vi.fn().mockImplementation(async () => {
      order.push(2);
    });
    registerPostTurnHook(hook1);
    registerPostTurnHook(hook2);

    await executePostTurnHooksSync(makeContext());

    expect(order).toEqual([1, 2]);
    expect(hook1).toHaveBeenCalled();
    expect(hook2).toHaveBeenCalled();
  });

  it('continues executing other hooks when one throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const hook1 = vi.fn().mockRejectedValue(new Error('fail'));
    const hook2 = vi.fn().mockResolvedValue(undefined);
    registerPostTurnHook(hook1);
    registerPostTurnHook(hook2);

    await executePostTurnHooksSync(makeContext());

    expect(hook1).toHaveBeenCalled();
    expect(hook2).toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[PostTurnHook] Error in synchronous hook execution:',
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });

  it('logs timeout warning after timeoutMs', async () => {
    vi.useFakeTimers();
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Hook that resolves after the timeout
    const slowHook = vi.fn().mockImplementation(
      () => new Promise<void>(r => setTimeout(r, 2000))
    );
    registerPostTurnHook(slowHook);

    const execPromise = executePostTurnHooksSync(makeContext(), 500);

    // Advance past the timeout warning
    vi.advanceTimersByTime(501);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[PostTurnHook] Hook execution timed out after',
      500,
      'ms'
    );

    // Advance past hook completion
    vi.advanceTimersByTime(2001);
    await execPromise;

    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('clears timeout on normal completion', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    registerPostTurnHook(vi.fn().mockResolvedValue(undefined));

    await executePostTurnHooksSync(makeContext(), 1000);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('clears timeout even when hook throws', async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    registerPostTurnHook(vi.fn().mockRejectedValue(new Error('fail')));

    await executePostTurnHooksSync(makeContext(), 1000);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('does nothing when no hooks registered', async () => {
    await executePostTurnHooksSync(makeContext());
    // No error thrown
  });

  it('uses default timeout of 60000ms', async () => {
    vi.useFakeTimers();
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Use a hook that resolves via setTimeout so fake timers can control it
    registerPostTurnHook(vi.fn().mockImplementation(
      () => new Promise<void>(r => setTimeout(r, 70000))
    ));

    const execPromise = executePostTurnHooksSync(makeContext());

    // Advance to just before default timeout
    vi.advanceTimersByTime(59999);
    expect(consoleWarnSpy).not.toHaveBeenCalled();

    // Advance past default timeout
    vi.advanceTimersByTime(2);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[PostTurnHook] Hook execution timed out after',
      60000,
      'ms'
    );

    // Advance past hook completion to let the function return
    vi.advanceTimersByTime(70001);
    await execPromise;

    consoleWarnSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe('multiple hooks execution order', () => {
  it('executePostTurnHooksSync runs hooks in registration order', async () => {
    const order: string[] = [];
    registerPostTurnHook(vi.fn().mockImplementation(async () => { order.push('first'); }));
    registerPostTurnHook(vi.fn().mockImplementation(async () => { order.push('second'); }));
    registerPostTurnHook(vi.fn().mockImplementation(async () => { order.push('third'); }));

    await executePostTurnHooksSync(makeContext());

    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('context passing', () => {
  it('passes full context to hooks including messages', async () => {
    const receivedContexts: PostTurnHookContext[] = [];
    registerPostTurnHook(vi.fn().mockImplementation(async (ctx: PostTurnHookContext) => {
      receivedContexts.push(ctx);
    }));

    const messages = [{ role: 'user' as const, content: 'test message' }];
    const context = makeContext({
      messages,
      systemPrompt: 'custom system prompt',
      querySource: 'cli',
    });

    await executePostTurnHooksSync(context);

    expect(receivedContexts).toHaveLength(1);
    expect(receivedContexts[0].messages).toBe(messages);
    expect(receivedContexts[0].systemPrompt).toBe('custom system prompt');
    expect(receivedContexts[0].querySource).toBe('cli');
  });

  it('passes same context reference to all hooks', async () => {
    const receivedContexts: PostTurnHookContext[] = [];
    registerPostTurnHook(vi.fn().mockImplementation(async (ctx: PostTurnHookContext) => {
      receivedContexts.push(ctx);
    }));
    registerPostTurnHook(vi.fn().mockImplementation(async (ctx: PostTurnHookContext) => {
      receivedContexts.push(ctx);
    }));

    const context = makeContext();
    await executePostTurnHooksSync(context);

    expect(receivedContexts).toHaveLength(2);
    expect(receivedContexts[0]).toBe(receivedContexts[1]);
  });
});

describe('executePostTurnHooks fire-and-forget with mixed success/failure', () => {
  it('calls all hooks even when some reject', async () => {
    const hook1 = vi.fn().mockRejectedValue(new Error('fail'));
    const hook2 = vi.fn().mockResolvedValue(undefined);
    const hook3 = vi.fn().mockResolvedValue(undefined);
    registerPostTurnHook(hook1);
    registerPostTurnHook(hook2);
    registerPostTurnHook(hook3);

    vi.spyOn(console, 'error').mockImplementation(() => {});
    await executePostTurnHooks(makeContext());
    await new Promise(r => setTimeout(r, 50));

    expect(hook1).toHaveBeenCalled();
    expect(hook2).toHaveBeenCalled();
    expect(hook3).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
