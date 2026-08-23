// QueryEngine Comprehensive Coverage Tests - Part 3
// Covers: streaming phase (basic), deciding phase
//
// T04 (C4) de-watered: see ./helpers/coverage-harness.ts for the mock policy.
// Tool-streaming cases now register a real tool whose side effects land in a
// MockExecutionEnv; assertions check executed outcomes, not event counts alone.

import {
  describe, it, expect, vi, beforeEach } from 'vitest';

import {
    resetHarness,
  createTestEngine,
  collectEvents,
  setStream,
  textEvents,
  makeToolCall,
  twoTurnStream,
  makeTool,
  ok as toolOk,
  makeMockEnv,
  getStreamFactory,
  getTokenEstimate,
  setCustomStreamChat,
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

import { QueryEngine } from '../../src/query/QueryEngine';

describe('QueryEngine Coverage Part 3', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    resetHarness();
  });

  describe('streaming phase', () => {
    it('should handle multiple text delta events', async () => {
      setStream([
        { type: 'text_delta', text: 'Hello ' },
        { type: 'text_delta', text: 'world' },
        { type: 'text_delta', text: '!' },
        { type: 'stop' },
      ]);

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const textDeltas = events.filter(e => e.type === 'agent:text_delta');
      expect(textDeltas).toHaveLength(3);
      expect(textDeltas[0].text).toBe('Hello ');
      expect(textDeltas[1].text).toBe('world');
      expect(textDeltas[2].text).toBe('!');
    });

    it('should handle error events during streaming', async () => {
      setStream([{ type: 'error', error: new Error('API error') }]);

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThan(0);
    });

    it('should execute tool_use events against MockExecutionEnv and return file content', async () => {
      const { env } = makeMockEnv();
      await env.fs.writeFile('/tmp/test.txt', 'FILE-BODY-42');

      const reader = makeTool('FileRead', async (input) => {
        const content = await env.fs.readFile(String((input as Record<string, unknown>).path));
        return toolOk(content);
      });

      twoTurnStream(
        (async function* () {
          yield { type: 'tool_use', toolCall: makeToolCall('FileRead', { path: '/tmp/test.txt' }) };
          yield { type: 'stop' };
        })(),
        'Done reading.',
      );

      engine = createTestEngine({}, [reader as any]);
      const events = await collectEvents(engine, 'test');

      // Outcome: the read really happened through the mock filesystem.
      const completed = events.filter(e => e.type === 'agent:tool_completed');
      expect(completed.length).toBeGreaterThanOrEqual(1);
      expect((completed[0] as any).result.output).toBe('FILE-BODY-42');
    });
  });

  describe('deciding phase', () => {
    it('should decide no tools when assistant has no tool calls', async () => {
      setStream(textEvents('Just text, no tools.'));

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const completeEvents = events.filter(e => e.type === 'agent:complete');
      expect(completeEvents.length).toBe(1);
      expect(events.filter(e => e.type.startsWith('agent:tool_'))).toHaveLength(0);
    });

    it('should decide tools when assistant has tool calls (executed for real)', async () => {
      const { env, fs } = makeMockEnv();

      let callCount = 0;
      setCustomFactory(() => {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            yield { type: 'text_delta', text: 'Running command...' };
            yield { type: 'tool_use', toolCall: makeToolCall('Echo', { command: 'echo hello' }) };
            yield { type: 'stop' };
          })();
        }
        return (async function* () {
          yield { type: 'text_delta', text: 'Done.' };
          yield { type: 'stop' };
        })();
      });

      const echo = makeTool('Echo', async () => {
        await env.fs.writeFile('/out/decided.txt', 'echo-ran');
        return toolOk('hello-from-echo');
      });

      engine = createTestEngine({}, [echo as any]);
      const events = await collectEvents(engine, 'test');

      // Decision produced execution: the tool body ran over the mock env.
      const completed = events.filter(e => e.type === 'agent:tool_completed');
      expect(completed.length).toBe(1);
      expect((completed[0] as any).result.output).toBe('hello-from-echo');
      expect(fs.listFiles()).toContain('/out/decided.txt');
      expect(await env.fs.readFile('/out/decided.txt')).toBe('echo-ran');
    });
  });
});

/** Swap the raw stream factory (local shorthand over the shared hoisted ref). */
function setCustomFactory(factory: () => AsyncGenerator<any>) {
  setCustomStreamChat(factory);
}
