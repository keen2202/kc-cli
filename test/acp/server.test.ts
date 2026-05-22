// Tests for ACP JSON-RPC Server
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to make mock variables available in hoisted vi.mock factories
const { mockHandleInitialize, mockHandleAgentRun, mockHandleAgentCancel, mockHandleSessionList } = vi.hoisted(() => ({
  mockHandleInitialize: vi.fn(),
  mockHandleAgentRun: vi.fn(),
  mockHandleAgentCancel: vi.fn(),
  mockHandleSessionList: vi.fn(),
}));

// Mock stdin/stdout
const mockStdin = {
  setEncoding: vi.fn(),
  on: vi.fn(),
};

const mockStdout = {
  write: vi.fn(),
};

vi.stubGlobal('process', {
  ...process,
  stdin: mockStdin,
  stdout: mockStdout,
});

vi.mock('../../src/acp/handlers', () => ({
  handleInitialize: mockHandleInitialize,
  handleAgentRun: mockHandleAgentRun,
  handleAgentCancel: mockHandleAgentCancel,
  handleSessionList: mockHandleSessionList,
}));

vi.mock('../../src/query/QueryEngine', () => ({
  QueryEngine: vi.fn(),
}));

import { ACPServer } from '../../src/acp/server';

describe('ACPServer', () => {
  let server: ACPServer;
  let stdinHandlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    stdinHandlers = {};

    mockStdin.on.mockImplementation((event: string, handler: Function) => {
      stdinHandlers[event] = handler;
    });

    server = new ACPServer();
  });

  describe('constructor', () => {
    it('should create handler state with session map', () => {
      expect(mockStdin.on).not.toHaveBeenCalled(); // start() hasn't been called
    });
  });

  describe('start', () => {
    it('should set encoding and register stdin handlers', async () => {
      const startPromise = server.start();

      expect(mockStdin.setEncoding).toHaveBeenCalledWith('utf-8');
      expect(mockStdin.on).toHaveBeenCalledWith('data', expect.any(Function));
      expect(mockStdin.on).toHaveBeenCalledWith('end', expect.any(Function));

      stdinHandlers['end']();
      await startPromise;
    });
  });

  describe('processBuffer', () => {
    it('should parse JSON-RPC requests and dispatch to handlers', async () => {
      const startPromise = server.start();

      const data = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { cwd: '/test' },
      }) + '\n';

      stdinHandlers['data'](data);

      expect(mockHandleInitialize).toHaveBeenCalledTimes(1);
      expect(mockHandleInitialize).toHaveBeenCalledWith(
        expect.objectContaining({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { cwd: '/test' },
        }),
        expect.objectContaining({
          sessions: expect.any(Map),
          sendResult: expect.any(Function),
          sendError: expect.any(Function),
          sendNotification: expect.any(Function),
        })
      );

      stdinHandlers['end']();
      await startPromise;
    });

    it('should handle multiple requests in one chunk', async () => {
      const startPromise = server.start();

      const data = [
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/list' }),
      ].join('\n') + '\n';

      stdinHandlers['data'](data);

      expect(mockHandleInitialize).toHaveBeenCalledTimes(1);
      expect(mockHandleSessionList).toHaveBeenCalledTimes(1);

      stdinHandlers['end']();
      await startPromise;
    });

    it('should handle partial messages across chunks', async () => {
      const startPromise = server.start();

      const full = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n';
      const mid = Math.floor(full.length / 2);

      stdinHandlers['data'](full.slice(0, mid));
      expect(mockHandleInitialize).not.toHaveBeenCalled();

      stdinHandlers['data'](full.slice(mid));
      expect(mockHandleInitialize).toHaveBeenCalledTimes(1);

      stdinHandlers['end']();
      await startPromise;
    });

    it('should skip empty lines', async () => {
      const startPromise = server.start();

      stdinHandlers['data']('\n\n\n');
      expect(mockHandleInitialize).not.toHaveBeenCalled();

      stdinHandlers['end']();
      await startPromise;
    });

    it('should send parse error for invalid JSON', async () => {
      const startPromise = server.start();

      stdinHandlers['data']('not json\n');

      expect(mockStdout.write).toHaveBeenCalledTimes(1);
      const response = JSON.parse(mockStdout.write.mock.calls[0][0]);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.error.code).toBe(-32700);
      expect(response.error.message).toBe('Parse error');

      stdinHandlers['end']();
      await startPromise;
    });

    it('should dispatch agent/run to handleAgentRun', async () => {
      const startPromise = server.start();

      stdinHandlers['data'](JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'agent/run', params: { prompt: 'hi' },
      }) + '\n');

      expect(mockHandleAgentRun).toHaveBeenCalledTimes(1);

      stdinHandlers['end']();
      await startPromise;
    });

    it('should dispatch agent/cancel to handleAgentCancel', async () => {
      const startPromise = server.start();

      stdinHandlers['data'](JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'agent/cancel', params: { sessionId: 's1' },
      }) + '\n');

      expect(mockHandleAgentCancel).toHaveBeenCalledTimes(1);

      stdinHandlers['end']();
      await startPromise;
    });

    it('should send method not found for unknown methods', async () => {
      const startPromise = server.start();

      stdinHandlers['data'](JSON.stringify({
        jsonrpc: '2.0', id: 42, method: 'unknown/method',
      }) + '\n');

      expect(mockStdout.write).toHaveBeenCalledTimes(1);
      const response = JSON.parse(mockStdout.write.mock.calls[0][0]);
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toContain('unknown/method');

      stdinHandlers['end']();
      await startPromise;
    });

    it('should send internal error when handler throws', async () => {
      const startPromise = server.start();

      mockHandleInitialize.mockImplementationOnce(() => {
        throw new Error('Handler crash');
      });

      stdinHandlers['data'](JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
      }) + '\n');

      expect(mockStdout.write).toHaveBeenCalledTimes(1);
      const response = JSON.parse(mockStdout.write.mock.calls[0][0]);
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toBe('Handler crash');

      stdinHandlers['end']();
      await startPromise;
    });

    it('should handle non-Error thrown values', async () => {
      const startPromise = server.start();

      mockHandleInitialize.mockImplementationOnce(() => {
        throw 'string error';
      });

      stdinHandlers['data'](JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
      }) + '\n');

      const response = JSON.parse(mockStdout.write.mock.calls[0][0]);
      expect(response.error.code).toBe(-32603);
      expect(response.error.message).toBe('Internal error');

      stdinHandlers['end']();
      await startPromise;
    });
  });

  describe('sendResult', () => {
    it('should write JSON-RPC response to stdout', async () => {
      const startPromise = server.start();

      mockHandleInitialize.mockImplementationOnce((req: any, state: any) => {
        state.sendResult(req.id, { success: true });
      });

      stdinHandlers['data'](JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
      }) + '\n');

      const response = JSON.parse(mockStdout.write.mock.calls[0][0]);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBe(1);
      expect(response.result).toEqual({ success: true });

      stdinHandlers['end']();
      await startPromise;
    });
  });

  describe('sendError', () => {
    it('should write JSON-RPC error to stdout', async () => {
      const startPromise = server.start();

      stdinHandlers['data']('bad json\n');

      const response = JSON.parse(mockStdout.write.mock.calls[0][0]);
      expect(response.jsonrpc).toBe('2.0');
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32700);

      stdinHandlers['end']();
      await startPromise;
    });

    it('should use id 0 when id is null', async () => {
      const startPromise = server.start();

      stdinHandlers['data']('bad json\n');

      const response = JSON.parse(mockStdout.write.mock.calls[0][0]);
      expect(response.id).toBe(0);

      stdinHandlers['end']();
      await startPromise;
    });
  });

  describe('sendNotification', () => {
    it('should be available in handler state', async () => {
      const startPromise = server.start();

      mockHandleAgentRun.mockImplementationOnce((req: any, state: any) => {
        state.sendNotification('test/notify', { data: 'value' });
        state.sendResult(req.id, {});
      });

      stdinHandlers['data'](JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'agent/run', params: { prompt: 'hi' },
      }) + '\n');

      const writes = mockStdout.write.mock.calls.map((c: any) => JSON.parse(c[0]));
      const notification = writes.find((w: any) => w.method === 'test/notify');
      expect(notification).toBeDefined();
      expect(notification.params).toEqual({ data: 'value' });

      stdinHandlers['end']();
      await startPromise;
    });
  });

  describe('running state', () => {
    it('should set running to false on stdin end', async () => {
      const startPromise = server.start();

      stdinHandlers['end']();
      await startPromise;
    });
  });
});
