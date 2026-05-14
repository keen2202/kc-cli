// Tests for permission interaction handler

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PermissionHandler, isPermissionGranted, formatPermissionResult } from '../../src/permissions/interaction';
import type { ToolCall } from '../../src/types/message';

// Mock readline
const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('readline', () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

function makeToolCall(toolName: string, input: Record<string, unknown> = {}): ToolCall {
  return {
    id: 'call_1',
    toolName,
    input,
    status: 'completed',
  };
}

describe('PermissionHandler', () => {
  let handler: PermissionHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('y'));
    handler = new PermissionHandler({ timeout: 0 });
  });

  afterEach(() => {
    handler.close();
  });

  describe('handlePermission', () => {
    it('should return allow immediately for allow behavior', async () => {
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'allow', updatedInput: {} }
      );
      expect(result.behavior).toBe('allow');
    });

    it('should return deny immediately for deny behavior', async () => {
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'deny', message: 'Denied by policy' }
      );
      expect(result.behavior).toBe('deny');
    });

    it('should ask user for ask behavior', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('y'));

      const result = await handler.handlePermission(
        makeToolCall('Bash', { command: 'ls' }),
        { behavior: 'ask', message: 'Needs permission' }
      );
      expect(result.behavior).toBe('allow');
    });
  });

  describe('user responses', () => {
    it('should allow on "y"', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('y'));
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );
      expect(result.behavior).toBe('allow');
    });

    it('should allow on "yes"', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('yes'));
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );
      expect(result.behavior).toBe('allow');
    });

    it('should deny on "n"', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('n'));
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );
      expect(result.behavior).toBe('deny');
    });

    it('should deny on "no"', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('no'));
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );
      expect(result.behavior).toBe('deny');
    });

    it('should allow on "always"', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('always'));
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );
      expect(result.behavior).toBe('allow');
      expect(result.decisionReason?.type).toBe('user_always_allow');
    });

    it('should deny on "always-deny"', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('always-deny'));
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );
      expect(result.behavior).toBe('deny');
      expect(result.decisionReason?.type).toBe('user_always_deny');
    });

    it('should deny on unclear answer', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('maybe'));
      const result = await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );
      expect(result.behavior).toBe('deny');
    });
  });

  describe('decision log', () => {
    it('should log decisions', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('y'));
      await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );

      const log = handler.getDecisionLog();
      expect(log).toHaveLength(1);
      expect(log[0].tool).toBe('Bash');
    });

    it('should clear decision log', async () => {
      mockQuestion.mockImplementation((_q: string, cb: (answer: string) => void) => cb('y'));
      await handler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );

      handler.clearDecisionLog();
      expect(handler.getDecisionLog()).toHaveLength(0);
    });
  });

  describe('timeout', () => {
    it('should deny on timeout', async () => {
      const timeoutHandler = new PermissionHandler({ timeout: 50 });
      // Don't answer the question - simulate timeout
      mockQuestion.mockImplementation((_q: string, _cb: (answer: string) => void) => {
        // Never call cb - simulate timeout
      });

      const result = await timeoutHandler.handlePermission(
        makeToolCall('Bash'),
        { behavior: 'ask', message: '' }
      );
      expect(result.behavior).toBe('deny');
      timeoutHandler.close();
    });
  });
});

describe('isPermissionGranted', () => {
  it('should return true for allow', () => {
    expect(isPermissionGranted({ behavior: 'allow', updatedInput: {} })).toBe(true);
  });

  it('should return false for deny', () => {
    expect(isPermissionGranted({ behavior: 'deny', message: '' })).toBe(false);
  });

  it('should return false for ask', () => {
    expect(isPermissionGranted({ behavior: 'ask', message: '' })).toBe(false);
  });
});

describe('formatPermissionResult', () => {
  it('should format allow result', () => {
    const formatted = formatPermissionResult({ behavior: 'allow', updatedInput: {} });
    expect(formatted).toContain('allow');
  });

  it('should format deny result', () => {
    const formatted = formatPermissionResult({ behavior: 'deny', message: 'Denied' });
    expect(formatted).toContain('deny');
  });

  it('should format ask result', () => {
    const formatted = formatPermissionResult({ behavior: 'ask', message: 'Please confirm' });
    expect(formatted).toContain('ask');
  });
});
