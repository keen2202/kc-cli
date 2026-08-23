import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * Behavior tests for the subprocess worker entrypoint (T14 / round3-H7),
 * executed IN-PROCESS so the runs count toward coverage instrumentation.
 *
 * What is real here: the entire `src/orchestrator/backends/subprocess-worker.ts`
 * module — its IPC protocol handling, agent loop, accounting and error paths.
 *
 * What is doubled: only the QueryEngine seam (the heavy dependency the worker
 * dynamically imports), via the same preset-response approach as the repo's
 * MockLLMClient convention. The worker itself, its protocol and its message
 * shapes are exercised verbatim; `process.send` is replaced with a recorder
 * because the vitest fork pool binds its own copy at boot (verified: harness
 * reporting is unaffected), and `process.exit` is stubbed around tests that
 * trigger the worker's self-exit timers so the runner survives.
 *
 * Complementary END-TO-END coverage of this worker — spawned as a REAL child
 * process through SubprocessBackend over real IPC — lives in
 * `test/orchestrator/backends-subprocess.test.ts`.
 */

interface ScriptEvent {
  type: string;
  [key: string]: unknown;
}

const workerHarness = vi.hoisted(() => {
  interface FakeInstance {
    cfg: Record<string, unknown>;
    submitCalls: string[];
    abortReasons: (string | undefined)[];
    scripts: Array<ScriptEvent[] | Error>;
  }
  const registry = {
    instances: [] as FakeInstance[],
    /** Scripts consumed sequentially, one entry per submitMessage() call. */
    defaultScripts: [] as Array<ScriptEvent[] | Error>,
    ctorThrows: null as Error | null,
  };

  class FakeQueryEngine {
    cfg: Record<string, unknown>;
    submitCalls: string[];
    abortReasons: (string | undefined)[];
    scripts: Array<ScriptEvent[] | Error>;

    constructor(cfg: Record<string, unknown>) {
      if (registry.ctorThrows) throw registry.ctorThrows;
      this.cfg = cfg;
      this.submitCalls = [];
      this.abortReasons = [];
      this.scripts = registry.defaultScripts.slice();
      registry.instances.push(this);
    }

    async *submitMessage(message: string): AsyncGenerator<ScriptEvent> {
      this.submitCalls.push(message);
      while (this.scripts.length > 0) {
        const step = this.scripts.shift() as ScriptEvent[] | Error;
        if (step instanceof Error) throw step;
        for (const ev of step) yield ev;
      }
    }

    abort(reason?: string): void {
      this.abortReasons.push(reason);
    }

    isAborted(): boolean {
      return this.abortReasons.length > 0;
    }
  }

  return { FakeQueryEngine, registry };
});

vi.mock('../../src/query/QueryEngine', () => ({
  QueryEngine: workerHarness.FakeQueryEngine,
}));

// ---- IPC transport doubles --------------------------------------------------

let sentMessages: Array<Record<string, unknown>>;
let originalSend: typeof process.send | undefined;
let originalExit: typeof process.exit;
let exitCalls: Array<number | undefined>;
let workerMessageListeners: Array<(msg: unknown) => Promise<void> | void> = [];
let workerUncaughtListeners: Array<(err: Error) => void> = [];
let workerRejectionListeners: Array<(reason: unknown) => void> = [];
let bootFrames: Array<Record<string, unknown>> = [];

function installTransportDoubles(): void {
  sentMessages = [];
  originalSend = process.send;
  originalExit = process.exit;
  exitCalls = [];
  // The vitest fork pool binds process.send at boot, so replacing it here does
  // not interfere with harness traffic — it only captures worker output.
  (process as unknown as { send: unknown }).send = ((msg: unknown) => {
    sentMessages.push(msg as Record<string, unknown>);
    return true;
  }) as unknown as typeof process.send;
  (process as unknown as { exit: unknown }).exit = ((code?: number) => {
    exitCalls.push(code);
    return undefined as never;
  }) as unknown as typeof process.exit;
}

function restoreTransportDoubles(): void {
  if (originalSend !== undefined) {
    (process as unknown as { send: unknown }).send = originalSend;
  } else {
    delete (process as unknown as { send?: unknown }).send;
  }
  (process as unknown as { exit: unknown }).exit = originalExit;
}

/** Dispatches one parent->worker protocol message to the worker's handlers. */
async function fromParent(msg: unknown): Promise<void> {
  for (const listener of workerMessageListeners) {
    await listener(msg);
  }
}

function sentOf(type: string): Array<Record<string, unknown>> {
  return sentMessages.filter((m) => m.type === type);
}

// The worker module is imported ONCE (module singleton holds state such as the
// `aborted` flag), and IPC frames accumulate in `sentMessages`. Reset the
// recorder before every case so frame-count assertions are order-independent;
// cases that need the worker in an aborted state must ARRANGE that themselves.
beforeEach(() => {
  sentMessages = [];
});

beforeAll(async () => {
  process.env.KC_AGENT_ID = 'worker-it@default';
  installTransportDoubles();

  const beforeMessage = process.listeners('message');
  const beforeUncaught = process.listeners('uncaughtException');
  const beforeRejection = process.listeners('unhandledRejection');

  // The real worker module registers its IPC handlers at import time and
  // immediately announces readiness over the (doubled) channel.
  await import('../../src/orchestrator/backends/subprocess-worker.js');

  workerMessageListeners = process
    .listeners('message')
    .filter((l) => !beforeMessage.includes(l)) as Array<(msg: unknown) => Promise<void> | void>;
  workerUncaughtListeners = process
    .listeners('uncaughtException')
    .filter((l) => !beforeUncaught.includes(l)) as Array<(err: Error) => void>;
  workerRejectionListeners = process
    .listeners('unhandledRejection')
    .filter((l) => !beforeRejection.includes(l)) as Array<(reason: unknown) => void>;

  expect(workerMessageListeners).toHaveLength(1);

  // Preserve what the worker emitted during module load (the 'ready' frame) —
  // beforeEach resets `sentMessages` for isolation, so boot traffic must be
  // captured here.
  bootFrames = sentMessages.slice();
});

afterAll(async () => {
  // Allow the worker's self-exit timers (1s shutdown, 500ms uncaught) to fire
  // against the stubbed process.exit before anything is restored.
  await new Promise((r) => setTimeout(r, 1300));
  for (const l of workerUncaughtListeners) process.removeListener('uncaughtException', l);
  for (const l of workerRejectionListeners) process.removeListener('unhandledRejection', l);
  restoreTransportDoubles();
});

describe('subprocess worker protocol (in-process)', () => {
  it('announces readiness immediately at module load (FUN-01)', () => {
    // No deadlock: worker speaks first, parent answers with init.
    expect(bootFrames).toEqual([{ type: 'ready' }]);
  });

  it('ignores malformed parent messages without crashing or replying', async () => {
    const baseline = sentMessages.length;
    await fromParent(undefined);
    await fromParent(null);
    await fromParent({});
    await fromParent({ type: 42 });
    await fromParent({ type: 'unknown-kind' });
    expect(sentMessages.length).toBe(baseline);
  });

  it('rejects an init message without config via an error frame', async () => {
    await fromParent({ type: 'init' });
    const errors = sentOf('error');
    expect(errors).toHaveLength(1);
    expect((errors[0].error as { message: string }).message).toBe('Missing config in init message');
  });

  it('drops inter-agent messages while no engine has been initialized', async () => {
    const baseline = sentMessages.length;
    await fromParent({
      type: 'message',
      message: { type: 'user_message', from: 'peer@default', payload: { text: 'anyone there?' } },
    });
    expect(sentMessages.length).toBe(baseline);
    expect(workerHarness.registry.instances).toHaveLength(0);
  });

  it('runs the agent loop on init: forwards events, tallies usage, emits result', async () => {
    workerHarness.registry.defaultScripts = [
      [{ type: 'agent:text_delta', text: 'hello', timestamp: 1 }],
      [
        {
          type: 'agent:tool_completed',
          toolCall: { name: 'Bash', id: 't1' },
          result: { output: 'ok', metadata: { tokensUsed: 42 } },
          timestamp: 2,
        },
        {
          type: 'agent:tool_completed',
          toolCall: { name: 'Grep', id: 't2' },
          result: { metadata: { tokensUsed: '7' } }, // numeric coercion path
          timestamp: 3,
        },
      ],
      [{ type: 'agent:turn_complete', timestamp: 5 }], // no message -> output unchanged
      [{ type: 'agent:turn_complete', message: { content: 'final answer' }, timestamp: 6 }],
    ];

    await fromParent({
      type: 'init',
      config: {
        name: 'coder',
        prompt: 'write code',
        systemPromptMode: 'append',
        systemPrompt: 'be nice',
        maxTurns: 4,
        model: 'test-model-x',
      },
      permissionMode: 'default',
      cwd: '/tmp',
    });

    // Exactly one engine was constructed with the worker's fixed config...
    expect(workerHarness.registry.instances).toHaveLength(1);
    const engine = workerHarness.registry.instances[0];
    expect(engine.cfg).toEqual({
      model: 'test-model-x',
      provider: 'anthropic',
      maxTurns: 4,
      maxBudgetUsd: null,
      systemPrompt: 'be nice',
    });
    expect(engine.submitCalls).toEqual(['write code']);

    // ...every engine event was relayed over IPC in order...
    const events = sentOf('event');
    expect(events.map((m) => (m.event as ScriptEvent).type)).toEqual([
      'agent:text_delta',
      'agent:tool_completed',
      'agent:tool_completed',
      'agent:turn_complete',
      'agent:turn_complete',
    ]);

    // ...and the final result carries the accumulated counters.
    const results = sentOf('result');
    expect(results).toHaveLength(1);
    expect(results[0].result).toEqual({
      agentId: 'worker-it@default',
      name: 'coder',
      success: true,
      output: 'final answer',
      toolUseCount: 2,
      totalTokensUsed: 49, // 42 + Number('7')
      duration: expect.any(Number),
    });
    expect((results[0].result as { duration: number }).duration).toBeGreaterThanOrEqual(0);
  });

  it('feeds subsequent inter-agent user messages back through the same engine', async () => {
    const engine = workerHarness.registry.instances[0];
    engine.scripts.push([{ type: 'agent:text_delta', text: 'round two', timestamp: 7 }]);

    await fromParent({
      type: 'message',
      message: { type: 'user_message', from: 'peer@default', payload: { text: 'again please' } },
    });

    expect(engine.submitCalls).toEqual(['write code', 'again please']);
    const events = sentOf('event');
    expect(events.at(-1)?.event).toEqual({ type: 'agent:text_delta', text: 'round two', timestamp: 7 });
  });

  it('ignores inter-agent messages that are not user messages with text', async () => {
    const engine = workerHarness.registry.instances[0];
    const baselineSubmits = engine.submitCalls.length;
    const baselineEvents = sentOf('event').length;

    await fromParent({
      type: 'message',
      message: { type: 'permission_request', from: 'peer', payload: { tool: 'Bash' } },
    });
    await fromParent({ type: 'message', message: { type: 'user_message', from: 'peer', payload: {} } });
    await fromParent({ type: 'message' }); // no message body at all

    expect(engine.submitCalls).toHaveLength(baselineSubmits);
    expect(sentOf('event')).toHaveLength(baselineEvents);
  });

  it('reports engine failures mid-run as error frames including stack', async () => {
    workerHarness.registry.defaultScripts = [new Error('llm exploded')];

    await fromParent({
      type: 'init',
      config: { name: 'fragile', prompt: 'will fail' },
    });

    const errors = sentOf('error');
    expect(errors).toHaveLength(1);
    const err = errors[0].error as { message: string; stack?: string };
    expect(err.message).toBe('llm exploded');
    expect(typeof err.stack).toBe('string');
  });

  it('reports engine construction failures as error frames with stack', async () => {
    workerHarness.registry.ctorThrows = new Error('engine unavailable');
    try {
      await fromParent({
        type: 'init',
        config: { name: 'doomed', prompt: 'never starts' },
      });
    } finally {
      workerHarness.registry.ctorThrows = null;
    }

    const errors = sentOf('error');
    expect(errors).toHaveLength(1);
    const err = errors[0].error as { message: string; stack?: string };
    expect(err.message).toBe('engine unavailable');
    expect(String(err.stack)).toContain('engine unavailable');
  });

  it('shuts down gracefully: aborts the live engine and schedules exit 0', async () => {
    workerHarness.registry.defaultScripts = [[]]; // engine stays idle

    await fromParent({
      type: 'init',
      config: { name: 'sleeper', prompt: 'idle' },
    });
    expect(workerHarness.registry.instances).toHaveLength(3);

    const before = sentMessages.length;
    await fromParent({ type: 'shutdown', force: false });

    const engine = workerHarness.registry.instances.at(-1)!;
    expect(engine.abortReasons).toEqual(['Graceful shutdown']);
    expect(exitCalls).toEqual([]); // not yet — 1s grace timer

    await new Promise((r) => setTimeout(r, 1200));
    expect(exitCalls).toEqual([0]);
    expect(sentMessages.length).toBe(before); // no extra frames during shutdown
  });

  it('stops relaying work once aborted: a late init yields success=false', async () => {
    // Arrange the aborted state on THIS worker instance (self-contained — the
    // flag lives at module scope and would otherwise leak across cases).
    await fromParent({ type: 'shutdown', force: true });

    workerHarness.registry.defaultScripts = [
      [{ type: 'agent:text_delta', text: 'too late', timestamp: 8 }],
      [{ type: 'agent:text_delta', text: 'never seen', timestamp: 9 }],
    ];

    await fromParent({
      type: 'init',
      config: { name: 'latecomer', prompt: 'post-shutdown' },
    });

    // The loop checks `aborted` before relaying each event, so NOTHING leaks
    // out after shutdown — neither script step is observed by the parent.
    const events = sentOf('event').filter(
      (m) => (m.event as ScriptEvent).timestamp === 8 || (m.event as ScriptEvent).timestamp === 9,
    );
    expect(events.map((m) => (m.event as ScriptEvent).text)).toEqual([]);

    const results = sentOf('result');
    expect(results.at(-1)?.result).toMatchObject({
      agentId: 'worker-it@default',
      name: 'latecomer',
      success: false,
      output: 'No output generated', // fallback when nothing completed
      toolUseCount: 0,
      totalTokensUsed: 0,
    });
  });

  it('force shutdown requests an immediate abort with the force reason', async () => {
    await fromParent({ type: 'shutdown', force: true });
    const engine = workerHarness.registry.instances.at(-1)!;
    expect(engine.abortReasons.at(-1)).toBe('Force shutdown');
  });

  it('reports uncaught exceptions and schedules a nonzero exit', async () => {
    for (const listener of workerUncaughtListeners) {
      listener(new Error('boom-uncaught'));
    }
    const errors = sentOf('error');
    const last = errors.at(-1)!.error as { message: string; stack?: string };
    expect(last.message).toBe('Uncaught: boom-uncaught');
    expect(String(last.stack)).toContain('boom-uncaught');

    await new Promise((r) => setTimeout(r, 700));
    expect(exitCalls.at(-1)).toBe(1);
  });

  it('reports unhandled promise rejections without exiting', async () => {
    const beforeExits = exitCalls.length;
    for (const listener of workerRejectionListeners) {
      listener(new Error('rejected-op'));
    }
    const errors = sentOf('error');
    expect((errors.at(-1)!.error as { message: string }).message).toBe(
      'Unhandled rejection: Error: rejected-op',
    );
    // Rejections are reported but are not fatal.
    expect(exitCalls.length).toBe(beforeExits);
  });
});
