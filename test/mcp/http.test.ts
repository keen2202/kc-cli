// Tests for MCP HTTP transport - tests the real HttpTransport class
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch at the I/O boundary
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { HttpTransport } from '../../src/mcp/transports/http';

describe('HttpTransport', () => {
  let transport: HttpTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    transport = new HttpTransport();
  });

  describe('connect', () => {
    it('should set connected state on connect', async () => {
      await transport.connect('http://localhost:3000/mcp');
      expect(transport.isConnected()).toBe(true);
    });

    it('should merge custom headers', async () => {
      await transport.connect('http://localhost:3000/mcp', { 'X-Custom': 'value' });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ jsonrpc: '2.0', id: 1, result: 'test' }),
      });

      await transport.sendRequest('ping');

      const [, options] = mockFetch.mock.calls[0];
      expect(options.headers).toMatchObject({ 'X-Custom': 'value' });
    });
  });

  describe('sendRequest', () => {
    it('should reject if not connected', async () => {
      await expect(transport.sendRequest('test')).rejects.toThrow('not connected');
    });

    it('should send JSON-RPC request via fetch', async () => {
      await transport.connect('http://localhost:3000/mcp');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { tools: [] } }),
      });

      const result = await transport.sendRequest('tools/list');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('http://localhost:3000/mcp');
      expect(options.method).toBe('POST');

      const body = JSON.parse(options.body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('tools/list');
      expect(result).toEqual({ tools: [] });
    });

    it('should send params when provided', async () => {
      await transport.connect('http://localhost:3000/mcp');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
      });

      await transport.sendRequest('tools/call', { name: 'test' });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.params).toEqual({ name: 'test' });
    });

    it('should throw on non-OK response', async () => {
      await transport.connect('http://localhost:3000/mcp');

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      await expect(transport.sendRequest('test')).rejects.toThrow('HTTP error: 500');
    });

    it('should throw on JSON-RPC error response', async () => {
      await transport.connect('http://localhost:3000/mcp');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32601, message: 'Method not found' },
        }),
      });

      await expect(transport.sendRequest('unknown')).rejects.toThrow('MCP error -32601');
    });

    it('should increment message IDs', async () => {
      await transport.connect('http://localhost:3000/mcp');

      mockFetch.mockResolvedValue({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ jsonrpc: '2.0', id: 1, result: {} }),
      });

      await transport.sendRequest('m1');
      await transport.sendRequest('m2');

      const body1 = JSON.parse(mockFetch.mock.calls[0][1].body);
      const body2 = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(body2.id).toBe(body1.id + 1);
    });

    it('should handle SSE response stream', async () => {
      await transport.connect('http://localhost:3000/mcp');

      const notificationHandler = vi.fn();
      transport.onNotification(notificationHandler);

      const sseData = [
        'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/test","params":{}}\n\n',
        'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"done":true}}\n\n',
      ].join('');

      const reader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(sseData) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/event-stream']]),
        body: { getReader: () => reader },
      });

      const result = await transport.sendRequest('test');

      expect(result).toEqual({ done: true });
      expect(notificationHandler).toHaveBeenCalled();
    });

    it('should throw when SSE stream ends without result', async () => {
      await transport.connect('http://localhost:3000/mcp');

      const reader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/event-stream']]),
        body: { getReader: () => reader },
      });

      await expect(transport.sendRequest('test')).rejects.toThrow('SSE stream ended without result');
    });

    it('should handle SSE with error in stream', async () => {
      await transport.connect('http://localhost:3000/mcp');

      const sseData = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"Internal"}}\n\n';
      const reader = {
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode(sseData) })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        releaseLock: vi.fn(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/event-stream']]),
        body: { getReader: () => reader },
      });

      await expect(transport.sendRequest('test')).rejects.toThrow('MCP error -32603');
    });

    it('should throw when SSE response body is null', async () => {
      await transport.connect('http://localhost:3000/mcp');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'text/event-stream']]),
        body: null,
      });

      await expect(transport.sendRequest('test')).rejects.toThrow('No response body');
    });
  });

  describe('onNotification', () => {
    it('should register notification handler', () => {
      const handler = vi.fn();
      transport.onNotification(handler);
      // Handler is stored; verified through SSE test above
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('should set disconnected state', async () => {
      await transport.connect('http://localhost:3000/mcp');
      expect(transport.isConnected()).toBe(true);

      await transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });

    it('should be safe to disconnect when not connected', async () => {
      await expect(transport.disconnect()).resolves.not.toThrow();
    });
  });

  describe('isConnected', () => {
    it('should return false initially', () => {
      expect(transport.isConnected()).toBe(false);
    });

    it('should return true after connect', async () => {
      await transport.connect('http://localhost:3000');
      expect(transport.isConnected()).toBe(true);
    });

    it('should return false after disconnect', async () => {
      await transport.connect('http://localhost:3000');
      await transport.disconnect();
      expect(transport.isConnected()).toBe(false);
    });
  });
});
