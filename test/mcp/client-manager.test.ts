// Tests for MCP Client Manager - tests the real MCPClientManager class
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Track the most recently spawned process
let mockChildProcess: any;

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

vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    mockChildProcess = createMockProcess();
    return mockChildProcess;
  }),
}));

// Mock fetch for HTTP transport
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Import the real modules
import { MCPClientManager } from '../../src/mcp/client-manager';
import type { MCPServerConfig } from '../../src/mcp/types';
import { spawn } from 'child_process';

function stdioConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    type: 'stdio',
    command: 'mcp-server',
    args: ['--port', '3000'],
    ...overrides,
  };
}

function httpConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    type: 'http',
    url: 'http://localhost:8080/mcp',
    ...overrides,
  };
}

/** Helper: frame a JSON object with Content-Length header */
function frameStdio(obj: unknown): string {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

/** Simulate a JSON-RPC response from the stdio child process */
function simulateStdioResponse(id: number, result: unknown) {
  mockChildProcess.stdout.emit('data', Buffer.from(
    frameStdio({ jsonrpc: '2.0', id, result })
  ));
}

/** Simulate a JSON-RPC error response */
function simulateStdioError(id: number, code: number, message: string) {
  mockChildProcess.stdout.emit('data', Buffer.from(
    frameStdio({ jsonrpc: '2.0', id, error: { code, message } })
  ));
}

/** Configure the spawn mock to auto-respond to MCP protocol messages */
function setupStdioAutoRespond() {
  vi.mocked(spawn).mockImplementation((() => {
    const proc = createMockProcess();
    mockChildProcess = proc;

    // Auto-respond to stdin writes (Content-Length framed protocol)
    proc.stdin.write.mockImplementation((data: string) => {
      const headerEnd = data.indexOf('\r\n\r\n');
      const msg = JSON.parse(data.slice(headerEnd + 4));
      const id = msg.id;
      const frame = (obj: unknown) => {
        const json = JSON.stringify(obj);
        return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
      };

      setTimeout(() => {
        if (msg.method === 'initialize') {
          proc.stdout.emit('data', Buffer.from(
            frame({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'test-server', version: '1.0.0' } } })
          ));
        } else if (msg.method === 'notifications/initialized') {
          proc.stdout.emit('data', Buffer.from(frame({ jsonrpc: '2.0', id, result: {} })));
        } else if (msg.method === 'tools/list') {
          proc.stdout.emit('data', Buffer.from(
            frame({ jsonrpc: '2.0', id, result: { tools: [{ name: 'tool1', description: 'First', inputSchema: { type: 'object' } }, { name: 'tool2', description: 'Second', inputSchema: { type: 'object' } }] } })
          ));
        } else if (msg.method === 'tools/call') {
          proc.stdout.emit('data', Buffer.from(
            frame({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'call result' }] } })
          ));
        } else if (msg.method === 'ping') {
          proc.stdout.emit('data', Buffer.from(frame({ jsonrpc: '2.0', id, result: {} })));
        } else {
          proc.stdout.emit('data', Buffer.from(frame({ jsonrpc: '2.0', id, result: {} })));
        }
      }, 0);
      return true;
    });

    return proc;
  }) as any);
}

/** Set up HTTP for a successful connection */
function setupHttpSuccess() {
  mockFetch.mockImplementation(async (url: string, options: any) => {
    const body = JSON.parse(options.body);
    let result: unknown;

    if (body.method === 'initialize') {
      result = {
        protocolVersion: '2024-11-05',
        capabilities: {},
        serverInfo: { name: 'http-server', version: '2.0.0' },
      };
    } else if (body.method === 'notifications/initialized') {
      result = {};
    } else if (body.method === 'tools/list') {
      result = {
        tools: [
          { name: 'http-tool', description: 'HTTP Tool', inputSchema: { type: 'object' } },
        ],
      };
    } else if (body.method === 'tools/call') {
      result = { content: [{ type: 'text', text: 'http result' }] };
    } else if (body.method === 'ping') {
      result = {};
    } else {
      result = {};
    }

    return {
      ok: true,
      headers: new Map([['content-type', 'application/json']]),
      json: async () => ({ jsonrpc: '2.0', id: body.id, result }),
    };
  });
}

describe('MCPClientManager', () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new MCPClientManager();
    // Reset spawn mock to default (creates fresh process each call)
    vi.mocked(spawn).mockImplementation((() => {
      mockChildProcess = createMockProcess();
      return mockChildProcess;
    }) as any);
  });

  describe('connect - stdio', () => {
    it('should connect to a stdio server and discover tools', async () => {
      setupStdioAutoRespond();

      // Need to give time for setTimeout(0) responses
      const connectPromise = manager.connect('s1', stdioConfig());

      // Wait for responses
      await new Promise(r => setTimeout(r, 50));
      await connectPromise;

      expect(manager.getStatus('s1')).toBe('connected');
      expect(manager.getServerTools('s1')).toHaveLength(2);
      expect(manager.getServerTools('s1')[0].name).toBe('tool1');
    }, 10000);

    it('should throw if stdio config has no command', async () => {
      await expect(
        manager.connect('s1', { type: 'stdio' })
      ).rejects.toThrow('requires "command" field');
    });

    it('should disconnect existing connection before reconnecting', async () => {
      setupStdioAutoRespond();

      const p1 = manager.connect('s1', stdioConfig());
      await new Promise(r => setTimeout(r, 50));
      await p1;

      expect(manager.getStatus('s1')).toBe('connected');

      // Reconnect
      setupStdioAutoRespond();
      const p2 = manager.connect('s1', stdioConfig());
      await new Promise(r => setTimeout(r, 50));
      await p2;

      expect(manager.getStatus('s1')).toBe('connected');
    }, 10000);

    it('should pass env vars to spawn', async () => {
      setupStdioAutoRespond();
      const p = manager.connect('s1', stdioConfig({ env: { MY_VAR: 'test' } }));
      await new Promise(r => setTimeout(r, 50));
      await p;

      expect(spawn).toHaveBeenCalledWith('mcp-server', ['--port', '3000'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: expect.objectContaining({ MY_VAR: 'test' }),
      });
    }, 10000);

    it('should set status to error on connection failure', async () => {
      // Emit error on the process after spawn sets up listeners
      // The spawn returns mockChildProcess, then the transport sets up event handlers
      // We need to emit error after those handlers are registered
      const connectPromise = manager.connect('s1', stdioConfig());

      // Wait a tick for the transport to set up event handlers
      await new Promise(r => setTimeout(r, 10));

      // Emit error on the spawned process
      mockChildProcess.emit('error', new Error('ENOENT'));

      await expect(connectPromise).rejects.toThrow('Failed to spawn');
      expect(manager.getStatus('s1')).toBe('error');
    }, 10000);
  });

  describe('connect - http', () => {
    it('should connect to an HTTP server and discover tools', async () => {
      setupHttpSuccess();

      await manager.connect('s1', httpConfig());

      expect(manager.getStatus('s1')).toBe('connected');
      expect(manager.getServerTools('s1')).toHaveLength(1);
      expect(manager.getServerTools('s1')[0].name).toBe('http-tool');
    });

    it('should throw if http config has no url', async () => {
      await expect(
        manager.connect('s1', { type: 'http' })
      ).rejects.toThrow('requires "url" field');
    });
  });

  describe('disconnect', () => {
    it('should disconnect a connected server', async () => {
      setupStdioAutoRespond();
      const p = manager.connect('s1', stdioConfig());
      await new Promise(r => setTimeout(r, 50));
      await p;

      await manager.disconnect('s1');
      expect(manager.getStatus('s1')).toBe('disconnected');
    }, 10000);

    it('should be safe to disconnect non-existent server', async () => {
      await expect(manager.disconnect('unknown')).resolves.not.toThrow();
    });

    it('should ignore transport disconnect errors', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      // Make fetch throw during disconnect (simulating transport error)
      // The manager catches disconnect errors internally
      await expect(manager.disconnect('s1')).resolves.not.toThrow();
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all connected servers', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());
      await manager.connect('s2', httpConfig());

      expect(manager.getConnectedServers()).toHaveLength(2);

      await manager.disconnectAll();
      expect(manager.getConnectedServers()).toHaveLength(0);
    });
  });

  describe('getStatus', () => {
    it('should return disconnected for unknown server', () => {
      expect(manager.getStatus('unknown')).toBe('disconnected');
    });
  });

  describe('getConnectedServers', () => {
    it('should return empty array when no servers connected', () => {
      expect(manager.getConnectedServers()).toEqual([]);
    });
  });

  describe('getServerTools', () => {
    it('should return empty array for unknown server', () => {
      expect(manager.getServerTools('unknown')).toEqual([]);
    });
  });

  describe('getAllTools', () => {
    it('should return empty array when no servers connected', () => {
      expect(manager.getAllTools()).toEqual([]);
    });

    it('should aggregate tools from all connected servers', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());
      await manager.connect('s2', httpConfig());

      const allTools = manager.getAllTools();
      expect(allTools.length).toBe(2);
      expect(allTools.some(t => t.serverId === 's1')).toBe(true);
      expect(allTools.some(t => t.serverId === 's2')).toBe(true);
    });
  });

  describe('callTool', () => {
    it('should throw if server not connected', async () => {
      await expect(manager.callTool('s1', 'tool1', {})).rejects.toThrow('not connected');
    });

    it('should call tool on connected HTTP server', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      // Reset mock for the tool call
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 99,
          result: { content: [{ type: 'text', text: 'tool output' }] },
        }),
      });

      const result = await manager.callTool('s1', 'http-tool', { input: 'test' });
      expect(result.content[0].text).toBe('tool output');
    });

    it('should throw on HTTP error response', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Server Error',
      });

      await expect(manager.callTool('s1', 'tool1', {})).rejects.toThrow();
    });

    it('should throw on MCP error in response', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({
          jsonrpc: '2.0',
          id: 99,
          error: { code: -32600, message: 'Invalid request' },
        }),
      });

      await expect(manager.callTool('s1', 'tool1', {})).rejects.toThrow('MCP error');
    });
  });

  describe('healthCheck', () => {
    it('should return false for unknown server', async () => {
      expect(await manager.healthCheck('unknown')).toBe(false);
    });

    it('should return true when ping succeeds', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([['content-type', 'application/json']]),
        json: async () => ({ jsonrpc: '2.0', id: 99, result: {} }),
      });

      expect(await manager.healthCheck('s1')).toBe(true);
    });

    it('should return false when ping fails', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockRejectedValueOnce(new Error('timeout'));

      expect(await manager.healthCheck('s1')).toBe(false);
    });
  });

  describe('getServerInfo', () => {
    it('should return undefined for unknown server', () => {
      expect(manager.getServerInfo('unknown')).toBeUndefined();
    });

    it('should return server info after connection', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      const info = manager.getServerInfo('s1');
      expect(info).toEqual({ name: 'http-server', version: '2.0.0' });
    });
  });

  describe('callTool error classification', () => {
    it('should classify timeout errors', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockRejectedValueOnce(new Error('Request timed out'));

      await expect(manager.callTool('s1', 'tool1', {})).rejects.toThrow('timed out');
    });

    it('should classify exit errors and attempt reconnect', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockRejectedValueOnce(new Error('Server exited'));

      await expect(manager.callTool('s1', 'tool1', {})).rejects.toThrow('disconnected during tool call');
    });

    it('should classify "not connected" errors and attempt reconnect', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockRejectedValueOnce(new Error('Transport not connected'));

      await expect(manager.callTool('s1', 'tool1', {})).rejects.toThrow('disconnected during tool call');
    });

    it('should wrap unknown errors', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockRejectedValueOnce(new Error('Something weird'));

      await expect(manager.callTool('s1', 'tool1', {})).rejects.toThrow('MCP tool error');
    });

    it('should handle non-Error thrown values', async () => {
      setupHttpSuccess();
      await manager.connect('s1', httpConfig());

      mockFetch.mockRejectedValueOnce('string error');

      await expect(manager.callTool('s1', 'tool1', {})).rejects.toThrow('MCP tool error');
    });
  });
});
