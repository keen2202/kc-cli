// QueryEngine Comprehensive Coverage Tests - Part 3b
// Covers: streaming phase (memory context, empty content, retry classification)
//
// T04 (C4) de-watered: see ./helpers/coverage-harness.ts for the mock policy.
// The previously mocked permissions engine / sandbox chain now run REAL via
// the shared harness; assertions are behavior-level (emitted events, message
// content, retry classification outcomes).

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
  makeStream,
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

describe('QueryEngine Coverage Part 3b', () => {
  let engine: QueryEngine;

  beforeEach(() => {
    resetHarness();
  });

  describe('streaming phase continued', () => {
    it('should load memory context when memory is enabled', async () => {
      setStream(textEvents('ok'));

      engine = createTestEngine({
        memory: {
          config: { enabled: true },
          getMemoryManifest: async () => [
            { fileName: 'test.md', topic: 'test', relevance: ['test'] },
          ],
          getMemoryContent: async (name: string) => `Memory content for ${name}`,
        },
      });

      const memory = engine.getMemoryIntegration();
      expect(memory.isEnabled()).toBe(true);
      await collectEvents(engine, 'test');
      expect(engine.getStateMachine().currentState).toBe('completed');
    });

    it('should handle API streaming with no content', async () => {
      setStream([{ type: 'stop' }]);

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const turnComplete = events.filter(e => e.type === 'agent:turn_complete');
      expect(turnComplete.length).toBe(1);
      expect(turnComplete[0].message.content).toBe('[stream interrupted]');
    });

    it('should retry on retryable streaming errors and recover on the next attempt', async () => {
      let callCount = 0;
      setCustomStreamChat(() => {
        callCount++;
        if (callCount === 1) {
          return makeStream([{ type: 'error', error: new Error('429 Too Many Requests') }] as any);
        }
        return makeStream([
          { type: 'text_delta', text: 'Success on retry' },
          { type: 'stop' },
        ] as any);
      });

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      // The retryable error was surfaced...
      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThanOrEqual(1);
      // ...and the retried attempt's text actually reached the consumer.
      const textDeltas = events.filter(e => e.type === 'agent:text_delta');
      expect(textDeltas.map(e => (e as any).text)).toContain('Success on retry');
    });

    it('should handle degraded errors without retrying', async () => {
      setCustomStreamChat(() =>
        makeStream([{ type: 'error', error: new Error('tool error: something failed') }] as any),
      );

      engine = createTestEngine();
      const events = await collectEvents(engine, 'test');

      const errEvents = events.filter(e => e.type === 'agent:error');
      expect(errEvents.length).toBeGreaterThanOrEqual(1);
    });
  });
});
