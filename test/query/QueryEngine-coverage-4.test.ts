// QueryEngine Comprehensive Coverage Tests - Part 4
// Covers: executing phase over a MockExecutionEnv, REAL permission-engine
// decisions, error recovery, streaming retry exhaustion, multi-turn tool loop
//
// T04 (C4) de-watered: see ./helpers/coverage-harness.ts for the mock policy.
// The permissions engine and the sandbox decision layer run REAL; tool side
// effects land in a MockExecutionEnv (MockFileSystem/MockShell). Assertions
// check behavior outcomes — executed output, mock-filesystem state, real
// denial messages from the six-step deny-first engine — never call counts on
// security-critical mocks.

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  getStreamFactory,
  getTokenEstimate,
    resetHarness,
  createTestEngine,
  collectEvents,
  setStream,
  setCustomStreamChat,
  textEvents,
  textStream,
  makeStream,
  twoTurnStream,
  makeToolCall,
  makeTool,
  ok as toolOk,
  fail as toolFail,
  makeMockEnv,
} from './helpers/coverage-harness';

// ── Inline module mocks (vitest 4: must be declared in the test file) ──
const { mockChatImpl } = vi.hoisted(() => ({
  mockChatImpl: vi.fn(async () => ({
    content: 'mock summary',
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  })),
}));

vi.mock('../../src/api', () => ({
  createAPIClient: vi.fn(() => ({
    streamChat: vi.fn(async function* () { yield* getStreamFactory()(); }),
    chat: mockChatImpl,
  })),
  BaseApiClient: class {},
  ApiError: class ApiError extends Error {
    statusCode?: number;
    responseHeaders?: Record<string, string>;
    constructor(msg: string, code?: number, headers?: Record<string, string>) {
      super(msg);
      this.statusCode = code;
      this.responseHeaders = headers;
    }
  },
}));

vi.mock('../../src/services/compaction/functional', () => ({
  shouldCompact: vi.fn(() => true),
  microcompact: vi.fn((msgs: any[]) => ({ wasCompacted: false, messages: msgs, tokensSaved: 0 })),
  fullCompact: vi.fn(async (msgs: any[]) => ({ wasCompacted: false, messages: msgs, tokensSaved: 0 })),
  needsForceTruncation: vi.fn(() => false),
  forceTruncate: vi.fn((msgs: any[]) => ({ messages: msgs, tokensSaved: 0, wasCompacted: false })),
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: 3,
}));

vi.mock('../../src/utils/tokenEstimation', () => ({
  estimateMessageTokensArray: vi.fn(() => getTokenEstimate()),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
  estimateMessageTokens: vi.fn(() => getTokenEstimate()),
}));

// Only the host-spawning escape probe is replaced; the real sandbox decision
// layer (policy/availability/wrap/fallback) stays loaded.
vi.mock('../../src/services/sandbox-probe', () => ({
  SandboxProbe: class MockSandboxProbe {
    async verifyIsolation() {
      return { passed: 4, total: 4, results: [] as unknown[], failures: [] as unknown[], overallPassed: true };
    }
  },
}));

import { QueryEngine } from '../../src/query/QueryEngine';

// ── MockExecutionEnv helper (shared harness util) ──

function makeEnv() {
  return makeMockEnv();
}

describe('QueryEngine Coverage Part 4', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    resetHarness();
  });

  // ── Executing Phase (tools execute against a MockExecutionEnv) ──

  describe('executing phase', () => {
    it('should execute a registered tool through the REAL executor onto the MockFileSystem', async () => {
      const { env, fs } = makeEnv();
      const echo = makeTool('Echo', async (input) => {
        const body = `echo:${String((input as Record<string, unknown>).text)}`;
        await env.fs.writeFile('/out/hello.txt', body);
        return toolOk(body);
      });

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('Echo', { text: 'hi' }) };
          yield { type: 'stop' };
        })(),
        'Done.',
      );

      engine = createTestEngine({}, [echo]);
      const events = await collectEvents(engine, 'run it');

      const started = events.filter(e => e.type === 'agent:tool_started');
      const completed = events.filter(e => e.type === 'agent:tool_completed');
      expect(started.length).toBe(1);

      // Behavior outcome: the tool ran and its result is what it returned.
      expect(completed.length).toBe(1);
      expect((completed[0] as any).result.output).toBe('echo:hi');
      expect((completed[0] as any).result.isError).toBe(false);

      // Side effects landed in the MockFileSystem, not on disk.
      expect(fs.listFiles()).toContain('/out/hello.txt');
      expect(await env.fs.readFile('/out/hello.txt')).toBe('echo:hi');

      // Real sandbox decision layer engaged: it stamped a concrete decision
      // (value is host-dependent — true where bwrap exists, false otherwise).
      const metadata = (completed[0] as any).result.metadata as Record<string, unknown>;
      expect(typeof metadata.sandboxed).toBe('boolean');
      expect(typeof metadata.sandboxBackend).toBe('string');
      expect((metadata.sandboxBackend as string).length).toBeGreaterThan(0);
    });

    it('should execute multiple independent tool calls and persist both outcomes', async () => {
      const { env, fs } = makeEnv();
      const writer = (name: string, path: string) => makeTool(name, async () => {
        await env.fs.writeFile(path, `written-by:${name}`);
        return toolOk(`ok:${name}`);
      });

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('ToolA', {}) };
          yield { type: 'tool_use', toolCall: makeToolCall('ToolB', {}) };
          yield { type: 'stop' };
        })(),
        'All done.',
      );

      engine = createTestEngine({}, [writer('ToolA', '/a.txt'), writer('ToolB', '/b.txt')]);
      const events = await collectEvents(engine, 'run both');

      const completed = events.filter(e => e.type === 'agent:tool_completed');
      expect(completed).toHaveLength(2);
      const outputs = completed.map(e => (e as any).result.output as string);
      expect(outputs).toEqual(expect.arrayContaining(['ok:ToolA', 'ok:ToolB']));

      // Both files exist with the exact content each tool wrote.
      expect(await env.fs.readFile('/a.txt')).toBe('written-by:ToolA');
      expect(await env.fs.readFile('/b.txt')).toBe('written-by:ToolB');
      expect(fs.listFiles().sort()).toEqual(['/a.txt', '/b.txt']);
    });

    it('should surface a failing command as a tool_failed event via MockShell exit status', async () => {
      const { shell } = makeEnv();
      shell.setDefault({ stdout: '', stderr: 'command not found', exitCode: 1 });
      const bashLike = makeTool('Bash', async (input) => {
        const r = await shell.exec(String((input as Record<string, unknown>).command), { cwd: '/tmp' });
        return r.exitCode === 0 ? toolOk(r.stdout) : toolFail(r.stderr || `exit ${r.exitCode}`);
      });

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('Bash', { command: 'definitely-missing-cmd' }) };
          yield { type: 'stop' };
        })(),
        'It failed.',
      );

      engine = createTestEngine({}, [bashLike]);
      const events = await collectEvents(engine, 'run bad command');

      const failed = events.filter(e => e.type === 'agent:tool_failed');
      expect(failed).toHaveLength(1);
      expect((failed[0] as any).error.message).toContain('command not found');

      // The failure is recorded in the conversation history for the next turn.
      const toolMessages = engine.getMessages().filter(m => m.role === 'tool');
      expect(toolMessages.length).toBeGreaterThanOrEqual(1);
      expect(toolMessages[0].toolResults?.[0]).toMatchObject({ isError: true });
    });

    it('should complete normally when the assistant emits no tool calls', async () => {
      setStream(textEvents('No tools.'));
      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
      expect(events.filter(e => e.type.startsWith('agent:tool_'))).toHaveLength(0);
    });

    it('should append tool results to message history matching MockExecutionEnv outcomes', async () => {
      const { env } = makeEnv();
      const echo = makeTool('Echo', async () => toolOk('ran:history-case'));

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('Echo', {}) };
          yield { type: 'stop' };
        })(),
        'Done.',
      );

      engine = createTestEngine({}, [echo]);
      await collectEvents(engine, 'test');

      const toolMessages = engine.getMessages().filter(m => m.role === 'tool');
      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0].toolResults?.[0]).toMatchObject({
        output: 'ran:history-case',
        isError: false,
      });
      // Outcome consistency: history says it ran; no filesystem writes expected.
      expect(env.fs.listFiles()).toEqual([]);
    });
  });

  // ── REAL permission-engine decisions (C4 de-water) ──
  //
  // These cases drive the genuine six-step deny-first engine
  // (src/permissions/engine.ts) through the full QueryEngine — no
  // permissions/sandbox mocks anywhere — and assert the OUTCOME of real
  // decisions: which tools ran and what the MockFileSystem looks like after.

  describe('real permission engine decisions', () => {
    it('denies a tool listed in alwaysDenyRules (Step 1) without executing it', async () => {
      const { env, fs } = makeEnv();
      let bodyRan = false;
      const guarded = makeTool('Guarded', async () => {
        bodyRan = true;
        await env.fs.writeFile('/should-not-exist.txt', 'nope');
        return toolOk('ran');
      });

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('Guarded', {}) };
          yield { type: 'stop' };
        })(),
        'Okay, moving on.',
      );

      engine = createTestEngine({ permissionRules: { deny: ['Guarded'] } }, [guarded]);
      const events = await collectEvents(engine, 'try the guarded tool');

      const failed = events.filter(e => e.type === 'agent:tool_failed');
      expect(failed).toHaveLength(1);
      // REAL Step-1 policy decision message from src/permissions/engine.ts.
      expect((failed[0] as any).error.message).toContain('denied by policy');

      // Outcome: the tool body never executed, filesystem untouched.
      expect(bodyRan).toBe(false);
      expect(fs.listFiles()).toEqual([]);
    });

    it('fails safe on protected-path access: security-critical ask → non-interactive deny', async () => {
      const { env, fs } = makeEnv();
      let bodyRan = false;
      const readSecret = makeTool('ReadFile', async () => {
        bodyRan = true;
        return toolOk('secret contents');
      });

      twoTurnStream(
        (async function* () {
          // /etc/passwd is a bypass-immune protected path: even an armed
          // bypass must escalate to 'ask' (Step 3), and a headless engine
          // fail-safe-denies the ask instead of silently proceeding.
          yield { type: 'tool_use', toolCall: makeToolCall('ReadFile', { path: '/etc/passwd' }) };
          yield { type: 'stop' };
        })(),
        'Okay, skipping that file.',
      );

      engine = createTestEngine({}, [readSecret]);
      const events = await collectEvents(engine, 'read the password file');

      const failed = events.filter(e => e.type === 'agent:tool_failed');
      expect(failed).toHaveLength(1);
      // Real Step-3 → non-interactive ask fail-safe message from the executor.
      expect((failed[0] as any).error.message).toContain('Permission denied (non-interactive)');
      expect((failed[0] as any).error.message).toContain('protected path');

      expect(bodyRan).toBe(false);
      expect(fs.listFiles()).toEqual([]);
    });

    it('blocks WebFetch to internal network URLs (SSRF guard, Step 3)', async () => {
      let bodyRan = false;
      const webFetch = makeTool('WebFetch', async () => {
        bodyRan = true;
        return toolOk('internal page body');
      });

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('WebFetch', { url: 'http://127.0.0.1:8080/admin' }) };
          yield { type: 'stop' };
        })(),
        'Okay, not fetching that.',
      );

      engine = createTestEngine({}, [webFetch]);
      const events = await collectEvents(engine, 'fetch localhost admin');

      const failed = events.filter(e => e.type === 'agent:tool_failed');
      expect(failed).toHaveLength(1);
      expect((failed[0] as any).error.message).toContain('SSRF blocked');
      expect(bodyRan).toBe(false);
    });

    it('denies every tool when KC_ALLOW_BYPASS is not armed (S3 gate)', async () => {
      const { env, fs } = makeEnv();
      const echo = makeTool('Echo', async () => toolOk('ran'));

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('Echo', {}) };
          yield { type: 'stop' };
        })(),
        'Fine without it.',
      );

      delete process.env.KC_ALLOW_BYPASS;
      try {
        engine = createTestEngine({}, [echo]);
        const events = await collectEvents(engine, 'try without bypass arming');

        const failed = events.filter(e => e.type === 'agent:tool_failed');
        expect(failed).toHaveLength(1);
        expect((failed[0] as any).error.message).toContain('bypass requires KC_ALLOW_BYPASS=1');
        expect(fs.listFiles()).toEqual([]);
      } finally {
        process.env.KC_ALLOW_BYPASS = '1'; // restore harness arming
      }
    });
  });

  // ── Error Recovery ──

  describe('error recovery', () => {
    it('should transition to error state on unhandled exception', async () => {
      setCustomStreamChat(() => {
        throw new Error('Fatal connection error');
      });

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
      expect(engine.getStateMachine().isTerminal()).toBe(true);
    });

    it('should yield error event with proper structure', async () => {
      setStream([{ type: 'error', error: new Error('test error') }]);

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const errorEvent = events.find(e => e.type === 'agent:error');
      expect(errorEvent).toBeDefined();
      expect(errorEvent.error).toBeInstanceOf(Error);
      expect(errorEvent.recoverable).toBe(false);
      expect(errorEvent.timestamp).toBeDefined();
    });

    it('should handle non-Error exceptions', async () => {
      setCustomStreamChat(() => {
        throw 'string error';
      });

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
      expect(errEvents[0].error).toBeInstanceOf(Error);
    });

    it('should handle degraded errors thrown during stream iteration', async () => {
      // Throw from within the for-await loop (not yielded as event)
      // "tool error" prefix classifies as degraded, which returns silently
      setCustomStreamChat(() => {
        return (async function* () {
          yield { type: 'text_delta', text: 'partial' } as any;
          throw new Error('tool error: sandbox violation');
        })();
      });

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      // Degraded errors are caught silently; engine continues to deciding->completed
      expect(engine.getStateMachine().currentState).toBe('completed');
    });
  });

  // ── Streaming retry exhaustion ──

  describe('streaming retry exhaustion', () => {
    it('should give up after max retries on persistent errors', async () => {
      vi.useFakeTimers();
      setCustomStreamChat(() => {
        return makeStream([{ type: 'error', error: new Error('429 rate limit') }]);
      });

      engine = createTestEngine();
      const promise = collectEvents(engine, 'test');

      // Advance past retry delays (MAX_RETRIES=10, base ~5000ms with jitter)
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(10000);
      }

      const events = await promise;
      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);

      vi.useRealTimers();
    });

    it('should not retry non-retryable errors', async () => {
      let factoryCalls = 0;
      setCustomStreamChat(() => {
        factoryCalls++;
        return makeStream([{ type: 'error', error: new Error('401 unauthorized') }]);
      });

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
      // Non-retryable classification: the API factory was consulted exactly once.
      expect(factoryCalls).toBe(1);
    });

    it('should retry retryable errors thrown during iteration', async () => {
      vi.useFakeTimers();
      let factoryCalls = 0;
      setCustomStreamChat(() => {
        factoryCalls++;
        return (async function* () {
          yield { type: 'text_delta', text: 'partial' } as any;
          throw new Error('429 Too Many Requests');
        })();
      });

      engine = createTestEngine();
      const promise = collectEvents(engine, 'test');

      // Advance past retry delays (MAX_RETRIES=10, base ~5000ms with jitter)
      for (let i = 0; i < 11; i++) {
        await vi.advanceTimersByTimeAsync(10000);
      }

      const events = await promise;
      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
      // Retry discipline proven by behavior: the provider was reconsulted.
      expect(factoryCalls).toBeGreaterThan(1);

      vi.useRealTimers();
    });
  });

  // ── Multi-turn tool loop (data threaded through the MockExecutionEnv) ──

  describe('multi-turn tool loop', () => {
    it('should carry data from a read turn into a write turn across rounds', async () => {
      const { env, fs } = makeEnv();
      await env.fs.writeFile('/data/in.txt', 'PAYLOAD');

      let readerSaw = '';
      const reader = makeTool('Reader', async () => {
        readerSaw = await env.fs.readFile('/data/in.txt');
        return toolOk(readerSaw);
      });
      const writer = makeTool('Writer', async () => {
        await env.fs.writeFile('/data/out.txt', `${readerSaw}:done`);
        return toolOk('written');
      });

      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            yield { type: 'text_delta', text: 'Reading...' };
            yield { type: 'tool_use', toolCall: makeToolCall('Reader', {}) };
            yield { type: 'stop' };
          })();
        }
        if (callCount === 2) {
          return (async function* () {
            yield { type: 'text_delta', text: 'Writing...' };
            yield { type: 'tool_use', toolCall: makeToolCall('Writer', {}) };
            yield { type: 'stop' };
          })();
        }
        return textStream('All done!');
      });

      engine = createTestEngine({}, [reader, writer]);
      const events = await collectEvents(engine, 'do something');

      const started = events.filter(e => e.type === 'agent:tool_started');
      expect(started.length).toBeGreaterThanOrEqual(2);

      const completeEvents = events.filter(e => e.type === 'agent:complete');
      expect(completeEvents.length).toBe(1);
      expect(engine.getStateMachine().currentState).toBe('completed');

      // End-to-end outcome: turn-1 read fed turn-2 write through the mock FS.
      expect(await env.fs.readFile('/data/out.txt')).toBe('PAYLOAD:done');
    });
  });
});
