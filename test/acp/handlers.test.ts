// Tests for ACP request handlers - tests the real handler functions
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ACPRequest, ACPResponse, ACPSessionInfo } from '../../src/acp/types';
import type { ACPHandlerState } from '../../src/acp/handlers';

// Mock external dependencies at the I/O boundary
vi.mock('../../src/bootstrap/state', () => ({
  initializeState: vi.fn(),
  getState: vi.fn(() => ({ cwd: '/test/project' })),
}));

vi.mock('../../src/bootstrap/config', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    config: {
      model: 'test-model',
      provider: 'test-provider',
      apiKey: 'test-key',
      apiBaseUrl: 'http://test.api',
    },
  }),
}));

vi.mock('../../src/tools', () => ({
  toolRegistry: {
    getAllTools: vi.fn(() => []),
  },
  registerBuiltInTools: vi.fn().mockResolvedValue(undefined),
}));

// Mock QueryEngine with a class-like constructor
vi.mock('../../src/query/QueryEngine', () => {
  return {
    QueryEngine: vi.fn().mockImplementation(function (this: any) {
      this.submitMessage = vi.fn(async function* () {
        yield { type: 'agent:text_delta', text: 'Hello' };
        yield { type: 'agent:complete' };
      });
      this.abort = vi.fn();
    }),
  };
});

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}));

// Import the REAL handlers module
import {
  handleInitialize,
  handleAgentRun,
  handleAgentCancel,
  handleSessionList,
} from '../../src/acp/handlers';
import { QueryEngine } from '../../src/query/QueryEngine';

function createRequest(method: string, params?: Record<string, unknown>, id: number | string = 1): ACPRequest {
  return { jsonrpc: '2.0', id, method, params };
}

function createState(): ACPHandlerState & {
  results: Array<{ id: number | string; result: unknown }>;
  errors: Array<{ id: number | string | null; code: number; message: string }>;
  notifications: Array<{ method: string; params?: Record<string, unknown> }>;
} {
  const results: Array<{ id: number | string; result: unknown }> = [];
  const errors: Array<{ id: number | string | null; code: number; message: string }> = [];
  const notifications: Array<{ method: string; params?: Record<string, unknown> }> = [];

  return {
    sessions: new Map(),
    sendResult: vi.fn((id, result) => { results.push({ id, result }); }),
    sendError: vi.fn((id, code, message) => { errors.push({ id, code, message }); }),
    sendNotification: vi.fn((method, params) => { notifications.push({ method, params }); }),
    results,
    errors,
    notifications,
  };
}

describe('ACP Handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleInitialize', () => {
    it('should respond with server info and capabilities', async () => {
      const state = createState();
      const request = createRequest('initialize', { cwd: '/my/project' });

      await handleInitialize(request, state);

      expect(state.results).toHaveLength(1);
      expect(state.results[0].id).toBe(1);
      const result = state.results[0].result as any;
      expect(result.protocolVersion).toBe('1.0');
      expect(result.serverInfo.name).toBe('kc-cli');
      expect(result.capabilities.tools).toBe(true);
      expect(result.capabilities.streaming).toBe(true);
    });

    it('should use defaults when params are missing', async () => {
      const state = createState();
      const request = createRequest('initialize');

      await handleInitialize(request, state);

      expect(state.results).toHaveLength(1);
    });

    it('should use provided model and provider', async () => {
      const { initializeState } = await import('../../src/bootstrap/state');
      const state = createState();
      const request = createRequest('initialize', {
        cwd: '/test',
        model: 'gpt-4',
        provider: 'openai',
      });

      await handleInitialize(request, state);

      expect(initializeState).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/test' })
      );
    });
  });

  describe('handleAgentRun', () => {
    it('should start an agent and return session ID', async () => {
      const state = createState();
      const request = createRequest('agent/run', { prompt: 'Hello world' });

      await handleAgentRun(request, state);

      expect(state.results).toHaveLength(1);
      const result = state.results[0].result as any;
      expect(result.sessionId).toBe('test-uuid-1234');
      expect(result.status).toBe('started');
      expect(state.sessions.has('test-uuid-1234')).toBe(true);
    });

    it('should use provided sessionId', async () => {
      const state = createState();
      const request = createRequest('agent/run', {
        prompt: 'test',
        sessionId: 'custom-id',
      });

      await handleAgentRun(request, state);

      const result = state.results[0].result as any;
      expect(result.sessionId).toBe('custom-id');
      expect(state.sessions.has('custom-id')).toBe(true);
    });

    it('should error when prompt is missing', async () => {
      const state = createState();
      const request = createRequest('agent/run', {});

      await handleAgentRun(request, state);

      expect(state.errors).toHaveLength(1);
      expect(state.errors[0].code).toBe(-32602);
      expect(state.errors[0].message).toContain('prompt');
    });

    it('should error when prompt is empty string', async () => {
      const state = createState();
      const request = createRequest('agent/run', { prompt: '' });

      await handleAgentRun(request, state);

      expect(state.errors).toHaveLength(1);
      expect(state.errors[0].code).toBe(-32602);
    });

    it('should create QueryEngine with correct config', async () => {
      const state = createState();
      const request = createRequest('agent/run', { prompt: 'test' });

      await handleAgentRun(request, state);

      expect(QueryEngine).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          provider: 'test-provider',
          apiKey: 'test-key',
          maxTurns: 50,
        }),
        []
      );
    });

    it('should store session info with running status', async () => {
      const state = createState();
      const request = createRequest('agent/run', { prompt: 'test' });

      await handleAgentRun(request, state);

      const session = state.sessions.get('test-uuid-1234');
      expect(session).toBeDefined();
      expect(session!.info.status).toBe('running');
      expect(session!.info.model).toBe('test-model');
      expect(session!.info.provider).toBe('test-provider');
    });
  });

  describe('handleAgentCancel', () => {
    it('should cancel a running session', () => {
      const state = createState();
      const mockEngine = { abort: vi.fn() };

      state.sessions.set('sess-1', {
        engine: mockEngine as any,
        info: {
          sessionId: 'sess-1',
          model: 'm',
          provider: 'p',
          status: 'running',
          createdAt: Date.now(),
        },
      });

      const request = createRequest('agent/cancel', { sessionId: 'sess-1' });
      handleAgentCancel(request, state);

      expect(mockEngine.abort).toHaveBeenCalledWith('User cancelled');
      expect(state.results).toHaveLength(1);
      const result = state.results[0].result as any;
      expect(result.status).toBe('cancelled');
      expect(state.sessions.get('sess-1')!.info.status).toBe('completed');
    });

    it('should error when session not found', () => {
      const state = createState();
      const request = createRequest('agent/cancel', { sessionId: 'nonexistent' });

      handleAgentCancel(request, state);

      expect(state.errors).toHaveLength(1);
      expect(state.errors[0].code).toBe(-32602);
      expect(state.errors[0].message).toContain('nonexistent');
    });
  });

  describe('handleSessionList', () => {
    it('should return empty list when no sessions', () => {
      const state = createState();
      const request = createRequest('session/list');

      handleSessionList(request, state);

      expect(state.results).toHaveLength(1);
      const result = state.results[0].result as any;
      expect(result.sessions).toEqual([]);
    });

    it('should return all session info', () => {
      const state = createState();

      const info1: ACPSessionInfo = {
        sessionId: 's1', model: 'm1', provider: 'p1', status: 'running', createdAt: 1000,
      };
      const info2: ACPSessionInfo = {
        sessionId: 's2', model: 'm2', provider: 'p2', status: 'completed', createdAt: 2000,
      };

      state.sessions.set('s1', { engine: {} as any, info: info1 });
      state.sessions.set('s2', { engine: {} as any, info: info2 });

      const request = createRequest('session/list');
      handleSessionList(request, state);

      const result = state.results[0].result as any;
      expect(result.sessions).toHaveLength(2);
    });
  });
});
