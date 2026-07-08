// Tests for ACP request handlers

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAgentRun, handleInitialize, type ACPHandlerState } from './handlers';

// Mock bootstrap modules used by handleAgentRun
vi.mock('../bootstrap/state', () => ({
  initializeState: vi.fn(),
  getState: () => ({ cwd: '/tmp' }),
}));

vi.mock('../bootstrap/config', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    config: {
      model: 'deepseek-v4-pro',
      provider: 'deepseek',
      apiKey: 'test-key',
      maxTurns: 10,
    },
  }),
}));

vi.mock('../tools', () => ({
  registerBuiltInTools: vi.fn().mockResolvedValue(undefined),
  toolRegistry: {
    getAllTools: () => [],
  },
}));

// Mock QueryEngine to avoid complex constructor dependencies
const { mockSubmitMessage } = vi.hoisted(() => ({
  mockSubmitMessage: vi.fn(),
}));

vi.mock('../query/QueryEngine', () => ({
  QueryEngine: vi.fn().mockImplementation(function () {
    return {
      submitMessage: mockSubmitMessage,
      abort: vi.fn(),
    };
  }),
}));

describe('handleAgentRun', () => {
  let state: ACPHandlerState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      sessions: new Map(),
      sendResult: vi.fn(),
      sendError: vi.fn(),
      sendNotification: vi.fn(),
    };
  });

  it('reports background agent failure via agent/error notification', async () => {
    // Make submitMessage throw during async iteration
    mockSubmitMessage.mockImplementation(async function* () {
      throw new Error('Agent execution failed');
    });

    await handleAgentRun(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'agent/run',
        params: { prompt: 'Test prompt' },
      },
      state,
    );

    // Wait for background execution to complete
    await vi.waitFor(() => {
      expect(state.sendNotification).toHaveBeenCalledWith(
        'agent/error',
        expect.objectContaining({
          sessionId: expect.any(String),
          error: 'Agent execution failed',
        }),
      );
    });
  });

  it('reports background agent failure via notification even when internal handler fails', async () => {
    // Make submitMessage throw
    mockSubmitMessage.mockImplementation(async function* () {
      throw new Error('Agent execution failed');
    });

    // Make the first agent/error notification throw (simulating internal catch failure)
    // so the error propagates to the outer .catch() handler
    let internalCatchFailed = false;
    state.sendNotification = vi.fn((method: string) => {
      if (method === 'agent/error' && !internalCatchFailed) {
        internalCatchFailed = true;
        throw new Error('Notification service unavailable');
      }
    });

    await handleAgentRun(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'agent/run',
        params: { prompt: 'Test prompt' },
      },
      state,
    );

    // Wait for background execution. The outer .catch() should have sent the
    // agent/error notification after the internal catch failed.
    await vi.waitFor(() => {
      expect(state.sendNotification).toHaveBeenCalledWith(
        'agent/error',
        expect.objectContaining({
          sessionId: expect.any(String),
          error: 'Agent execution failed',
        }),
      );
    });
  });
});

describe('handleInitialize', () => {
  let state: ACPHandlerState;

  beforeEach(() => {
    vi.clearAllMocks();
    state = {
      sessions: new Map(),
      sendResult: vi.fn(),
      sendError: vi.fn(),
      sendNotification: vi.fn(),
    };
  });

  it('creates a per-connection ServiceContainer with scoped state and logger', async () => {
    await handleInitialize(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { cwd: '/test/project' },
      },
      state,
    );

    // Container must exist on the handler state
    expect(state.container).toBeDefined();

    // Scoped state must be resolvable
    const gs = state.container!.resolve<{ cwd: string }>('globalState');
    expect(gs.cwd).toBe('/test/project');

    // Scoped logger must be resolvable
    const log = state.container!.resolve<{ info: Function }>('logger');
    expect(log).toBeDefined();
    expect(typeof log.info).toBe('function');
  });

  it('uses defaults when no params provided', async () => {
    await handleInitialize(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {},
      },
      state,
    );

    expect(state.container).toBeDefined();
    // Should use process.cwd() when not specified
    const gs = state.container!.resolve<{ cwd: string }>('globalState');
    expect(gs.cwd).toBe(process.cwd());
  });

  it('provides independent containers across separate connections', async () => {
    const state1: ACPHandlerState = {
      sessions: new Map(),
      sendResult: vi.fn(),
      sendError: vi.fn(),
      sendNotification: vi.fn(),
    };
    const state2: ACPHandlerState = {
      sessions: new Map(),
      sendResult: vi.fn(),
      sendError: vi.fn(),
      sendNotification: vi.fn(),
    };

    await handleInitialize(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { cwd: '/project/a' } },
      state1,
    );
    await handleInitialize(
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: { cwd: '/project/b' } },
      state2,
    );

    // Each connection gets its own container
    expect(state1.container).not.toBe(state2.container);

    // Each container has independent state
    const gs1 = state1.container!.resolve<{ cwd: string }>('globalState');
    const gs2 = state2.container!.resolve<{ cwd: string }>('globalState');
    expect(gs1.cwd).toBe('/project/a');
    expect(gs2.cwd).toBe('/project/b');
  });
});
