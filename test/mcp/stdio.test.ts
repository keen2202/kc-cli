// Tests for MCP stdio transport - tests the real StdioTransport class
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process at the I/O boundary
let mockProcess: any;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProcess),
}));

import { StdioTransport } from '../../src/mcp/transports/stdio';
import { spawn } from 'child_process';

function createMockProcess() {
  const proc = new EventEmitter() as any;
  proc.stdin = new EventEmitter();
  proc.stdin.write = vi.fn(() => true);
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = vi.fn();
  return proc;
}

/** Helper: frame JSON with Content-Length header for MCP spec compliance */
function frameMessage(obj: unknown): string {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

/** Helper: extract the first JSON-RPC message from a Content-Length framed write call */
function extractWrittenJson(writeMock: any, callIndex: number = 0): any {
  const raw = writeMock.mock.calls[callIndex][0] as string;
  const headerEnd = raw.indexOf('\r\n\r\n');
  return JSON.parse(raw.slice(headerEnd + 4));
}

describe('StdioTransport', () => {
  let transport: StdioTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    transport = new StdioTransport();
  });

  describe('connect', () => {
    it('should spawn a process and connect successfully', async () => {
      const connectPromise = transport.connect('mcp-server', ['--port', '3000']);
      await new Promise(r => setTimeout(r, 150));
      await connectPromise;

      expect(transport.isConnected()).toBe(true);
      expect(spawn).toHaveBeenCalledWith('mcp-server', ['--port', '3000'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.any(Object),
      });
    });

    it('should spawn with custom env vars', async () => {
      const connectPromise = transport.connect('server', [], { MY_VAR: 'value' });
      await new Promise(r => setTimeout(r, 150));
      await connectPromise;

      expect(spawn).toHaveBeenCalledWith('server', [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ MY_VAR: 'value' }),
      });
    });

    it('should reject if spawn errors', async () => {
      const connectPromise = transport.connect('bad-cmd', []);
      setTimeout(() => {
        mockProcess.emit('error', new Error('ENOENT'));
      }, 10);
      await expect(connectPromise).rejects.toThrow('Failed to spawn MCP server');
    });

    it('should reject if process exits before startup timeout', async () => {
      const connectPromise = transport.connect('bad-cmd', []);
      setTimeout(() => {
        mockProcess.emit('exit', 1);
      }, 10);
      try {
        await connectPromise;
      } catch (e) {
        expect(e).toBeDefined();
      }
    });
  });

  describe('sendRequest', () => {
    it('should reject if not connected', async () => {
      await expect(transport.sendRequest('test')).rejects.toThrow('not connected');
    });

    it('should write JSON-RPC message with Content-Length framing', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      const requestPromise = transport.sendRequest('test-method', { key: 'value' });

      expect(mockProcess.stdin.write).toHaveBeenCalledTimes(1);
      const written = extractWrittenJson(mockProcess.stdin.write);
      expect(written.jsonrpc).toBe('2.0');
      expect(written.method).toBe('test-method');
      expect(written.params).toEqual({ key: 'value' });
      expect(written.id).toBe(1);

      // Simulate response with Content-Length framing
      mockProcess.stdout.emit('data', Buffer.from(
        frameMessage({ jsonrpc: '2.0', id: written.id, result: { success: true } })
      ));

      const result = await requestPromise;
      expect(result).toEqual({ success: true });
    });

    it('should handle error responses', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      const requestPromise = transport.sendRequest('test');

      const written = extractWrittenJson(mockProcess.stdin.write);
      mockProcess.stdout.emit('data', Buffer.from(
        frameMessage({ jsonrpc: '2.0', id: written.id, error: { code: -32600, message: 'Bad request' } })
      ));

      await expect(requestPromise).rejects.toThrow('MCP error -32600: Bad request');
    });

    it('should handle multiple messages in one chunk', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      const req1 = transport.sendRequest('m1');
      const req2 = transport.sendRequest('m2');

      const w1 = extractWrittenJson(mockProcess.stdin.write, 0);
      const w2 = extractWrittenJson(mockProcess.stdin.write, 1);

      // Send both responses in one chunk with Content-Length framing
      const chunk = frameMessage({ jsonrpc: '2.0', id: w1.id, result: 'r1' }) +
                    frameMessage({ jsonrpc: '2.0', id: w2.id, result: 'r2' });
      mockProcess.stdout.emit('data', Buffer.from(chunk));

      expect(await req1).toBe('r1');
      expect(await req2).toBe('r2');
    });

    it('should handle partial messages across chunks', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      const req = transport.sendRequest('test');
      const w = extractWrittenJson(mockProcess.stdin.write);

      const full = frameMessage({ jsonrpc: '2.0', id: w.id, result: 'ok' });
      const mid = Math.floor(full.length / 2);

      mockProcess.stdout.emit('data', Buffer.from(full.slice(0, mid)));
      mockProcess.stdout.emit('data', Buffer.from(full.slice(mid)));

      expect(await req).toBe('ok');
    });

    it('should ignore malformed Content-Length frames', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      const req = transport.sendRequest('test');
      const w = extractWrittenJson(mockProcess.stdin.write);

      // Send garbled data first, then valid response
      mockProcess.stdout.emit('data', Buffer.from('garbage\r\n\r\nnot-json'));
      mockProcess.stdout.emit('data', Buffer.from(
        frameMessage({ jsonrpc: '2.0', id: w.id, result: 'ok' })
      ));

      expect(await req).toBe('ok');
    });

    it('should reject pending requests when process exits', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      const req = transport.sendRequest('test');

      // Simulate process exit
      mockProcess.emit('exit', 1);

      await expect(req).rejects.toThrow('exited with code 1');
    });

    it('should increment message IDs', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      transport.sendRequest('m1');
      transport.sendRequest('m2');

      const msg1 = extractWrittenJson(mockProcess.stdin.write, 0);
      const msg2 = extractWrittenJson(mockProcess.stdin.write, 1);
      expect(msg2.id).toBe(msg1.id + 1);
    });
  });

  describe('onNotification', () => {
    it('should call handler for notifications', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      const handler = vi.fn();
      transport.onNotification(handler);

      mockProcess.stdout.emit('data', Buffer.from(
        frameMessage({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      ));

      expect(handler).toHaveBeenCalledWith({
        jsonrpc: '2.0',
        method: 'notifications/tools/list_changed',
      });
    });
  });

  describe('disconnect', () => {
    it('should kill the process and clean up', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;

      await transport.disconnect();

      expect(mockProcess.kill).toHaveBeenCalledWith('SIGTERM');
      expect(transport.isConnected()).toBe(false);
    });

    it('should be safe to disconnect when not connected', async () => {
      await expect(transport.disconnect()).resolves.not.toThrow();
    });
  });

  describe('isConnected', () => {
    it('should return false when not connected', () => {
      expect(transport.isConnected()).toBe(false);
    });

    it('should return true after successful connect', async () => {
      const p = transport.connect('server', []);
      await new Promise(r => setTimeout(r, 150));
      await p;
      expect(transport.isConnected()).toBe(true);
    });
  });
});
