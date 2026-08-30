// O3: MCP reconnect failures and exhaustion must be visible — round4 §4-O3

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

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

import { MCPClientManager } from '../../src/mcp/client-manager';
import { spawn } from 'child_process';
import { spyOnLogger, type LoggerSpy } from '../helpers/logger-spy';

function frame(obj: unknown): string {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

/** Auto-respond so the initial connect + tool discovery succeed. */
function setupAutoRespond() {
  vi.mocked(spawn).mockImplementation((() => {
    const proc = createMockProcess();
    mockChildProcess = proc;
    proc.stdin.write.mockImplementation((data: string) => {
      const msg = JSON.parse(data.slice(data.indexOf('\r\n\r\n') + 4));
      const id = msg.id;
      setTimeout(() => {
        if (msg.method === 'initialize') {
          proc.stdout.emit('data', Buffer.from(frame({
            jsonrpc: '2.0', id,
            result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 's', version: '1' } },
          })));
        } else {
          proc.stdout.emit('data', Buffer.from(frame({ jsonrpc: '2.0', id, result: {} })));
        }
      }, 0);
      return true;
    });
    return proc;
  }) as any);
}

/** Every later spawn dies on first write → reconnect establishment fails. */
function setupDyingServer() {
  vi.mocked(spawn).mockImplementation((() => {
    const proc = createMockProcess();
    mockChildProcess = proc;
    proc.stdin.write.mockImplementation(() => {
      setTimeout(() => proc.emit('exit', 1), 0);
      return true;
    });
    return proc;
  }) as any);
}

describe('O3: MCP reconnect exhaustion is surfaced', () => {
  let manager: MCPClientManager;
  let spy: LoggerSpy;

  beforeEach(() => {
    setupAutoRespond();
    manager = new MCPClientManager();
  });

  afterEach(() => {
    spy?.stop();
    vi.restoreAllMocks();
  });

  it('logs each failed reconnect attempt with attempt/backoff context', async () => {
    spy = spyOnLogger('mcp', ['error']);
    await manager.connect('srv', { type: 'stdio', command: 'mcp-server', args: [] });

    setupDyingServer();
    mockChildProcess.emit('exit', 1); // transport → process = null

    await expect(manager.callTool('srv', 'tool1', {})).rejects.toThrow(/disconnected|not connected/i);

    const failed = spy.calls.filter((c) => c.message === 'MCP reconnect failed');
    expect(failed.length).toBe(1);
    expect(failed[0]!.data).toMatchObject({ serverId: 'srv', attempt: 1, maxAttempts: 3 });
  }, 15000);

  it('marks the server unavailable and fires the UI callback when attempts are exhausted', async () => {
    spy = spyOnLogger('mcp', ['error']);
    const unavailable: Array<{ serverId: string; reason: string }> = [];
    manager.setServerUnavailableHandler((serverId, reason) => unavailable.push({ serverId, reason }));

    await manager.connect('srv', { type: 'stdio', command: 'mcp-server', args: [] });

    setupDyingServer();
    mockChildProcess.emit('exit', 1);

    // Simulate a manager that already burned its reconnect budget before this
    // failure (the budget increments across successive failures in production).
    const conn = (manager as unknown as { connections: Map<string, { reconnectAttempts: number; status: string }> })
      .connections.get('srv')!;
    conn.reconnectAttempts = 3;

    await expect(manager.callTool('srv', 'tool1', {})).rejects.toThrow();

    expect(unavailable).toEqual([
      expect.objectContaining({ serverId: 'srv', reason: expect.stringContaining('exhausted') }),
    ]);
    const final = spy.calls.filter((c) => c.message === 'MCP server unavailable');
    expect(final.length).toBe(1);
    expect(final[0]!.data).toMatchObject({ serverId: 'srv', maxAttempts: 3 });
  }, 15000);
});
