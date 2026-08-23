// QueryEngine Comprehensive Coverage Tests - Part 1
// Covers: submitMessage full lifecycle, compacting phase, abort handling
//
// T04 (C4) de-watered: the permissions engine and the sandbox decision layer
// run REAL via ./helpers/coverage-harness.ts (only the host-spawning escape
// probe is stubbed inline below — no call-count assertions are made on it).
// Assertions are behavior-level: emitted events, state-machine transitions,
// message history and MockExecutionEnv outcomes. Compaction/tokenEstimation
// remain preset-driven stubs (non-security-critical inputs); cases that only
// re-asserted stub call counts were deleted in this pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    resetHarness,
  createTestEngine,
  collectEvents,
  setStream,
  setTokenEstimate,
  textEvents,
  toolStream,
  makeToolCall,
  twoTurnStream,
  makeTool,
  ok as toolOk,
  makeMockEnv,
  getStreamFactory,
  getTokenEstimate,
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

vi.mock('../../src/services/sandbox-probe', () => ({
  SandboxProbe: class MockSandboxProbe {
    async verifyIsolation() {
      return { passed: 4, total: 4, results: [] as unknown[], failures: [] as unknown[], overallPassed: true };
    }
  },
}));

// Preset-driven compaction stubs (non-security-critical inputs).
import {
  shouldCompact,
  fullCompact,
  microcompact,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from '../../src/services/compaction/functional';
import { QueryEngine } from '../../src/query/QueryEngine';

/**
 * Poll until `fullCompact` mock has been called at least once, or timeout.
 * P6 moved compaction to fire-and-forget — this avoids flaky hardcoded
 * setTimeout delays that break under CI load.
 */
async function waitForAsyncCompaction(timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((fullCompact as ReturnType<typeof vi.fn>).mock.calls.length > 0) {
      return;
    }
    await new Promise(r => setTimeout(r, 1));
  }
}

const COMPACTION_THRESHOLD = 200_000 - 20_000 - 13_000;

describe('QueryEngine Coverage Part 1', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    resetHarness();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── submitMessage Full Lifecycle ──

  describe('submitMessage full lifecycle', () => {
    it('should complete idle->compact->stream->decide->complete loop with no tool calls', async () => {
      setStream([{ type: 'text_delta', text: 'Hello, I can help with that.' }, { type: 'stop' }]);
      engine = createTestEngine();
      const events = await collectEvents(engine, 'help me');

      const textEvts = events.filter(e => e.type === 'agent:text_delta');
      const completeEvents = events.filter(e => e.type === 'agent:complete');

      expect(textEvts.length).toBeGreaterThan(0);
      expect(textEvts[0].text).toBe('Hello, I can help with that.');
      expect(completeEvents.length).toBe(1);
      expect(engine.getStateMachine().currentState).toBe('completed');

      const messages = engine.getMessages();
      expect(messages.some(m => m.role === 'user' && m.content === 'help me')).toBe(true);
      expect(messages.some(m => m.role === 'assistant' && m.content === 'Hello, I can help with that.')).toBe(true);
    });

    it('should complete full lifecycle with tool calls executed through the real executor', async () => {
      const { env, fs } = makeMockEnv();
      const echo = makeTool('Echo', async (input) => {
        const body = `echo:${String((input as Record<string, unknown>).text)}`;
        await env.fs.writeFile('/out/lifecycle.txt', body);
        return toolOk(body);
      });

      twoTurnStream(
        toolStream('Let me check that.', [makeToolCall('Echo', { text: 'ls' })]),
        'The directory has files.',
      );

      engine = createTestEngine({}, [echo as any]);
      const events = await collectEvents(engine, 'list files');

      // Behavior outcomes: the registered tool actually ran over MockExecutionEnv.
      const completed = events.filter(e => e.type === 'agent:tool_completed');
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect((completed[0] as any).result.output).toBe('echo:ls');
      expect(await env.fs.readFile('/out/lifecycle.txt')).toBe('echo:ls');
      expect(fs.listFiles()).toContain('/out/lifecycle.txt');

      expect(events.filter(e => e.type === 'agent:complete').length).toBe(1);
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should emit turn_complete event after streaming', async () => {
      setStream(textEvents('Response text'));
      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const turnComplete = events.filter(e => e.type === 'agent:turn_complete');
      expect(turnComplete.length).toBe(1);
      expect(turnComplete[0].message).toBeDefined();
      expect(turnComplete[0].usage).toBeDefined();
    });
  });

  // ── Compacting Phase ──

  describe('compacting phase', () => {
    it('should skip compaction when tokens are below threshold', async () => {
      (shouldCompact as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
      setTokenEstimate(1000);
      setStream(textEvents('ok'));
      engine = createTestEngine();
      await collectEvents(engine, 'test');
      // P6: no synchronous compaction functions called when shouldCompact returns false
      expect(fullCompact).not.toHaveBeenCalled();
    });

    it('should trigger async compaction when tokens exceed threshold', async () => {
      setTokenEstimate(COMPACTION_THRESHOLD + 1000);
      setStream(textEvents('ok'));

      (fullCompact as ReturnType<typeof vi.fn>).mockResolvedValue({
        wasCompacted: true,
        messages: [{ id: '1', role: 'user', content: 'test', timestamp: Date.now() }],
        tokensSaved: 5000,
      });

      engine = createTestEngine();
      await collectEvents(engine, 'test');
      // P6: compaction is fire-and-forget; wait for async to fire
      await waitForAsyncCompaction();

      expect(fullCompact).toHaveBeenCalled();
    });

    it('should not block the turn when compaction runs async', async () => {
      setTokenEstimate(COMPACTION_THRESHOLD + 1000);
      setStream(textEvents('ok'));

      let compactResolved = false;
      (fullCompact as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 50));
        compactResolved = true;
        return { wasCompacted: false, messages: [], tokensSaved: 0 };
      });

      engine = createTestEngine();
      await collectEvents(engine, 'test');

      // Turn completed without waiting for the 50ms compaction to finish
      expect(fullCompact).toHaveBeenCalled();
      expect(compactResolved).toBe(false);

      // Compaction eventually finishes after the turn
      await new Promise(r => setTimeout(r, 100));
      expect(compactResolved).toBe(true);
    });

    it('should disable compaction after max consecutive failures', async () => {
      setTokenEstimate(COMPACTION_THRESHOLD + 1000);

      (fullCompact as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));

      setStream(textEvents('ok'));
      engine = createTestEngine();

      for (let i = 0; i < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES + 2; i++) {
        await collectEvents(engine, `msg ${i}`);
        engine.getStateMachine().reset();
        await waitForAsyncCompaction();
      }

      vi.clearAllMocks();
      setStream(textEvents('ok'));
      await collectEvents(engine, 'final msg');
      // Negative case: compaction is disabled, so just flush microtasks
      await new Promise(r => setTimeout(r, 10));

      // After max failures, no further compaction calls should be made
      expect(fullCompact).not.toHaveBeenCalled();
    });

    it('should handle compaction error without crashing', async () => {
      setTokenEstimate(COMPACTION_THRESHOLD + 1000);
      setStream(textEvents('ok'));

      (fullCompact as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('permanent auth failure'));

      engine = createTestEngine({ contextWindow: 200_000 });
      // Turn should complete successfully even when async compaction fails
      await collectEvents(engine, 'test');
      // Wait for async compaction to fire and fail
      await waitForAsyncCompaction();
      expect(fullCompact).toHaveBeenCalled();
    });
  });

  // ── Abort Handling ──

  describe('abort handling', () => {
    it('should not start streaming when pre-aborted', async () => {
      engine = createTestEngine();
      engine.abort('cancelled before start');
      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().isTerminal()).toBe(true);
    });

    it('should stop during compacting phase when aborted', async () => {
      setTokenEstimate(COMPACTION_THRESHOLD + 1000);

      (microcompact as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        engine.abort('cancelled during compaction');
        return { wasCompacted: false, messages: [], tokensSaved: 0 };
      });

      setStream(textEvents('should not reach'));
      engine = createTestEngine({ contextWindow: 200_000 });
      const events = await collectEvents(engine, 'test');
      expect(engine.getStateMachine().isTerminal()).toBe(true);
    });

    it('should report isAborted correctly', async () => {
      engine = createTestEngine();
      expect(engine.isAborted()).toBe(false);
      engine.abort('test reason');
      expect(engine.isAborted()).toBe(true);
    });
  });
});
