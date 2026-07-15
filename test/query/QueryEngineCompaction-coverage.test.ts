// CompactionHandler Coverage Tests
// Covers: constructor, failure tracking, shouldAttemptCompaction, compact lifecycle,
// microcompact path, fullcompact path, force truncation, retry logic, state validation.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompactionHandler } from '../../src/query/QueryEngineCompaction';
import type { ChatMessage } from '../../src/types/message';

// ---------------------------------------------------------------------------
// Hoisted references — shared between vi.mock factories and test body so that
// per-test overrides (mockReturnValue, mockResolvedValue, etc.) take effect.
// ---------------------------------------------------------------------------

const {
  mockShouldCompact,
  mockMicrocompact,
  mockFullCompact,
  mockNeedsForceTruncation,
  mockForceTruncate,
  mockEstimateTokensRef,
  mockClassifyApiError,
  mockGetRetryDelay,
  mockStateValidatorValidate,
  mockStateValidatorRepair,
} = vi.hoisted(() => ({
  mockShouldCompact: vi.fn(() => true),
  mockMicrocompact: vi.fn(() => ({
    wasCompacted: false,
    messages: [] as any[],
    tokensSaved: 0,
  })),
  mockFullCompact: vi.fn(async function () {
    return { wasCompacted: false, messages: [] as any[], tokensSaved: 0 };
  }),
  mockNeedsForceTruncation: vi.fn(function () {
    return false;
  }),
  mockForceTruncate: vi.fn(function () {
    return { messages: [] as any[], tokensSaved: 0, wasCompacted: false };
  }),
  mockEstimateTokensRef: { value: 1000 },
  mockClassifyApiError: vi.fn(function () {
    return { retryable: false, retryAfterMs: 100, context: 'test' };
  }),
  mockGetRetryDelay: vi.fn(function () {
    return 100;
  }),
  mockStateValidatorValidate: vi.fn(function () {
    return { valid: true, issues: [], repaired: false };
  }),
  mockStateValidatorRepair: vi.fn(function (msgs: any) {
    return msgs;
  }),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/services/compaction', () => ({
  shouldCompact: mockShouldCompact,
  microcompact: mockMicrocompact,
  fullCompact: mockFullCompact,
  needsForceTruncation: mockNeedsForceTruncation,
  forceTruncate: mockForceTruncate,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES: 3,
}));

vi.mock('../../src/utils/tokenEstimation', () => ({
  estimateMessageTokensArray: vi.fn(function () {
    return mockEstimateTokensRef.value;
  }),
  estimateMessageTokens: vi.fn(function () {
    return mockEstimateTokensRef.value;
  }),
}));

vi.mock('../../src/services/error-classifier', () => ({
  classifyApiError: mockClassifyApiError,
  getRetryDelay: mockGetRetryDelay,
}));

// StateValidator must be a real class so that `new StateValidator()` works.
vi.mock('../../src/services/stateValidator', () => {
  class MockStateValidator {
    validate(...args: any[]) {
      return mockStateValidatorValidate(...args);
    }
    repair(...args: any[]) {
      return mockStateValidatorRepair(...args);
    }
  }
  return { StateValidator: MockStateValidator };
});

vi.mock('../../src/services/logger', () => ({
  logger: {
    query: { warn: vi.fn() },
    tools: { info: vi.fn(), warn: vi.fn() },
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(
  id: string,
  role: ChatMessage['role'] = 'user',
  content = 'test',
): ChatMessage {
  return { id, role, content, timestamp: Date.now() } as ChatMessage;
}

const messages: ChatMessage[] = [
  makeMessage('1', 'user', 'Hello'),
  makeMessage('2', 'assistant', 'Hi'),
];
const config = { contextWindow: 200_000, model: 'test-model' };
const mockApiClient = {} as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CompactionHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore default hoisted-ref values
    mockEstimateTokensRef.value = 1000;
    mockNeedsForceTruncation.mockReturnValue(false);
    mockStateValidatorValidate.mockReturnValue({
      valid: true,
      issues: [],
      repaired: false,
    });
    mockMicrocompact.mockReturnValue({
      wasCompacted: false,
      messages: [],
      tokensSaved: 0,
    });
    mockFullCompact.mockResolvedValue({
      wasCompacted: false,
      messages: [],
      tokensSaved: 0,
    });
    mockClassifyApiError.mockReturnValue({
      retryable: false,
      retryAfterMs: 100,
      context: 'test',
    });
  });

  // ── Constructor ────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('uses default maxFailures (MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES)', async () => {
      const handler = new CompactionHandler();
      expect(handler.failureCount).toBe(0);

      // Make compact fail so failureCount increments.
      mockFullCompact.mockRejectedValue(new Error('Compaction failed'));

      // Trigger exactly 3 failures — the default maximum.
      for (let i = 0; i < 3; i++) {
        await handler.compact(messages, mockApiClient, config);
      }

      expect(handler.shouldAttemptCompaction(messages, config)).toBe(false);
    });

    it('accepts custom maxFailures', async () => {
      const handler = new CompactionHandler(5);
      expect(handler.failureCount).toBe(0);

      mockFullCompact.mockRejectedValue(new Error('Compaction failed'));

      // 3 failures should be fine with a max of 5.
      for (let i = 0; i < 3; i++) {
        await handler.compact(messages, mockApiClient, config);
      }

      expect(handler.shouldAttemptCompaction(messages, config)).toBe(true);

      // 2 more to exhaust the budget.
      for (let i = 0; i < 2; i++) {
        await handler.compact(messages, mockApiClient, config);
      }

      expect(handler.shouldAttemptCompaction(messages, config)).toBe(false);
    });
  });

  // ── failureCount ───────────────────────────────────────────────────────

  describe('failureCount', () => {
    it('starts at 0', () => {
      const handler = new CompactionHandler();
      expect(handler.failureCount).toBe(0);
    });
  });

  // ── shouldAttemptCompaction ────────────────────────────────────────────

  describe('shouldAttemptCompaction', () => {
    it('returns false when failures >= max', async () => {
      const handler = new CompactionHandler(2);

      // Make compact fail each time.
      mockFullCompact.mockRejectedValue(new Error('Fatal error'));

      for (let i = 0; i < 2; i++) {
        await handler.compact(messages, mockApiClient, config);
      }

      expect(handler.shouldAttemptCompaction(messages, config)).toBe(false);
    });

    it('returns true normally when shouldCompact returns true', () => {
      const handler = new CompactionHandler();
      mockShouldCompact.mockReturnValue(true);

      const result = handler.shouldAttemptCompaction(messages, config);

      expect(result).toBe(true);
      expect(mockShouldCompact).toHaveBeenCalled();
    });

    it('returns true when force truncation is needed regardless of failure count', () => {
      const handler = new CompactionHandler();
      mockNeedsForceTruncation.mockReturnValue(true);

      // Even if failure count is high, force truncation should always be
      // attempted.
      const result = handler.shouldAttemptCompaction(messages, config);

      expect(result).toBe(true);
    });
  });

  // ── compact — microcompact path ────────────────────────────────────────

  describe('compact — microcompact', () => {
    it('returns microcompact result when microcompact succeeds and tokens are below threshold', async () => {
      const handler = new CompactionHandler();
      mockMicrocompact.mockReturnValue({
        wasCompacted: true,
        messages: [makeMessage('c1', 'user', 'compacted')],
        tokensSaved: 500,
      });
      mockEstimateTokensRef.value = 50_000; // below threshold (200k - 20k - 13k = 167k)

      const result = await handler.compact(messages, mockApiClient, config);

      expect(result.method).toBe('microcompact');
    });

    it('proceeds to full compact when microcompact leaves tokens above threshold', async () => {
      const handler = new CompactionHandler();
      mockMicrocompact.mockReturnValue({
        wasCompacted: true,
        messages: [makeMessage('c1', 'user', 'still-large')],
        tokensSaved: 100,
      });
      mockEstimateTokensRef.value = 180_000; // above threshold (167k)
      mockFullCompact.mockResolvedValue({
        wasCompacted: true,
        messages: [makeMessage('f1', 'user', 'full-compacted')],
        tokensSaved: 2000,
      });

      const result = await handler.compact(messages, mockApiClient, config);

      expect(result.method).toBe('fullcompact');
    });
  });

  // ── compact — full compact path ────────────────────────────────────────

  describe('compact — full compact', () => {
    it('returns fullcompact result after successful full compact', async () => {
      const handler = new CompactionHandler();
      // Skip microcompact (wasCompacted: false)
      mockMicrocompact.mockReturnValue({
        wasCompacted: false,
        messages,
        tokensSaved: 0,
      });
      mockFullCompact.mockResolvedValue({
        wasCompacted: true,
        messages: [makeMessage('f1', 'user', 'summary')],
        tokensSaved: 3000,
      });

      const result = await handler.compact(messages, mockApiClient, config);

      expect(result.method).toBe('fullcompact');
      expect(handler.failureCount).toBe(0); // reset on success
    });

    it('handles full compact error with retry (fail once, then succeed)', async () => {
      const handler = new CompactionHandler();
      mockMicrocompact.mockReturnValue({
        wasCompacted: false,
        messages,
        tokensSaved: 0,
      });
      mockClassifyApiError.mockReturnValue({
        retryable: true,
        retryAfterMs: 10,
        context: 'rate_limit',
      });

      // Fail on first call, succeed on second.
      mockFullCompact
        .mockRejectedValueOnce(new Error('Rate limited'))
        .mockResolvedValueOnce({
          wasCompacted: true,
          messages: [makeMessage('f1', 'user', 'retry-summary')],
          tokensSaved: 1000,
        });

      const result = await handler.compact(messages, mockApiClient, config);

      expect(mockFullCompact).toHaveBeenCalledTimes(2);
      expect(mockClassifyApiError).toHaveBeenCalled();
      // retryAfterMs was provided by classifyApiError, so getRetryDelay not used
      expect(mockGetRetryDelay).not.toHaveBeenCalled();
      expect(result.method).toBe('fullcompact');
      expect(handler.failureCount).toBe(0); // reset on final success
    });

    it('increments failureCount on unrecoverable error', async () => {
      const handler = new CompactionHandler();
      mockMicrocompact.mockReturnValue({
        wasCompacted: false,
        messages,
        tokensSaved: 0,
      });
      mockClassifyApiError.mockReturnValue({
        retryable: false,
        retryAfterMs: undefined,
        context: 'auth',
      });
      mockFullCompact.mockRejectedValue(new Error('Auth error'));

      await handler.compact(messages, mockApiClient, config);

      expect(handler.failureCount).toBe(1);
    });

    it('disables after max consecutive failures', async () => {
      const handler = new CompactionHandler(3);
      mockMicrocompact.mockReturnValue({
        wasCompacted: false,
        messages,
        tokensSaved: 0,
      });
      mockClassifyApiError.mockReturnValue({
        retryable: false,
        retryAfterMs: undefined,
        context: 'fatal',
      });
      mockFullCompact.mockRejectedValue(new Error('Fatal error'));

      // Exhaust the failure budget.
      for (let i = 0; i < 3; i++) {
        await handler.compact(messages, mockApiClient, config);
      }

      expect(handler.failureCount).toBe(3);
      // shouldAttemptCompaction must now return false.
      expect(handler.shouldAttemptCompaction(messages, config)).toBe(false);
    });
  });

  // ── compact — force truncation path ────────────────────────────────────

  describe('compact — force truncation', () => {
    it('returns force_truncate result for force truncation path', async () => {
      const handler = new CompactionHandler();
      const truncatedMsgs = [makeMessage('t1', 'user', 'truncated')];
      mockNeedsForceTruncation.mockReturnValue(true);
      mockForceTruncate.mockReturnValue({
        messages: truncatedMsgs,
        tokensSaved: 10_000,
        wasCompacted: true,
      });

      const result = await handler.compact(messages, mockApiClient, config);

      expect(result.method).toBe('force_truncate');
      expect(handler.failureCount).toBe(0); // reset on force truncate
    });
  });

  // ── compact — state validation ─────────────────────────────────────────

  describe('compact — state validation', () => {
    it('validates and repairs messages before compaction when validation fails', async () => {
      const handler = new CompactionHandler();
      const repairedMsgs = [makeMessage('r1', 'user', 'repaired')];

      mockStateValidatorValidate.mockReturnValue({
        valid: false,
        issues: [
          {
            type: 'orphaned_tool_result',
            messageIndex: 0,
            severity: 'error',
            detail: 'orphaned',
          },
        ],
        repaired: false,
      });
      mockStateValidatorRepair.mockReturnValue(repairedMsgs);
      mockMicrocompact.mockReturnValue({
        wasCompacted: true,
        messages: repairedMsgs,
        tokensSaved: 100,
      });
      mockEstimateTokensRef.value = 50_000; // below threshold

      const result = await handler.compact(messages, mockApiClient, config);

      expect(mockStateValidatorValidate).toHaveBeenCalledWith(messages);
      expect(mockStateValidatorRepair).toHaveBeenCalled();
      // The repaired messages should flow through to the result
      expect(result.messages).toBe(repairedMsgs);
    });
  });

  // ── reset ──────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears failureCount', async () => {
      const handler = new CompactionHandler();
      mockMicrocompact.mockReturnValue({
        wasCompacted: false,
        messages,
        tokensSaved: 0,
      });
      mockClassifyApiError.mockReturnValue({
        retryable: false,
        retryAfterMs: undefined,
        context: 'fatal',
      });
      mockFullCompact.mockRejectedValue(new Error('Fatal'));

      // Cause 2 failures
      for (let i = 0; i < 2; i++) {
        await handler.compact(messages, mockApiClient, config);
      }

      expect(handler.failureCount).toBe(2);

      handler.reset();

      expect(handler.failureCount).toBe(0);
      // After reset, shouldAttemptCompaction should return true again
      expect(handler.shouldAttemptCompaction(messages, config)).toBe(true);
    });
  });
});
