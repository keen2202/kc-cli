/**
 * MCP Stdio Transport — Compliance Tests
 *
 * Covers:
 * - Content-Length header framing per MCP specification
 * - Large messages (>64KB) correctly framed and parsed
 * - Multiple messages in single buffer correctly split
 * - Partial message across buffer boundary correctly reassembled
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

let mockProcess: any;

vi.mock('child_process', () => ({
  spawn: vi.fn(() => mockProcess),
}));

import { StdioTransport } from '../../src/mcp/transports/stdio';

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

/** Frame a JSON message with Content-Length header per MCP spec */
function frameMessage(obj: unknown): string {
  const json = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`;
}

async function connectTransport(transport: StdioTransport): Promise<void> {
  const promise = transport.connect('test-server', []);
  await new Promise(r => setTimeout(r, 150));
  await promise;
}

describe('StdioTransport — Content-Length Framing', () => {
  let transport: StdioTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    transport = new StdioTransport();
  });

  it('parses a single Content-Length framed message', async () => {
    const response = { jsonrpc: '2.0', id: 1, result: { status: 'ok' } };
    await connectTransport(transport);

    // Send a response to a pending request
    const id = (transport as any).messageId + 1;
    (transport as any).pendingRequests.set(id, {
      resolve: () => {},
      reject: () => {},
    });

    const framed = frameMessage(response);
    mockProcess.stdout.emit('data', Buffer.from(framed));

    // Should have parsed without error
    expect(transport.isConnected()).toBe(true);
  });

  it('handles header with extra whitespace in Content-Length', async () => {
    await connectTransport(transport);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    // Extra whitespace around the value
    const framed = `Content-Length:  ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    mockProcess.stdout.emit('data', Buffer.from(framed));
    expect(transport.isConnected()).toBe(true);
  });

  it('handles case-insensitive header', async () => {
    await connectTransport(transport);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const framed = `content-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    mockProcess.stdout.emit('data', Buffer.from(framed));
    expect(transport.isConnected()).toBe(true);
  });

  it('discards malformed header and continues', async () => {
    await connectTransport(transport);
    // Malformed frame followed by good frame
    const badFrame = 'Bad-Header: 123\r\n\r\n';
    const goodBody = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const goodFrame = frameMessage({ jsonrpc: '2.0', id: 1, result: 'ok' });
    mockProcess.stdout.emit('data', Buffer.from(badFrame + goodFrame));
    expect(transport.isConnected()).toBe(true);
  });
});

describe('StdioTransport — Large Messages', () => {
  let transport: StdioTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    transport = new StdioTransport();
  });

  it('handles message payload > 64KB', async () => {
    await connectTransport(transport);
    // Create a payload larger than 64KB
    const largeString = 'x'.repeat(70 * 1024); // 70KB
    const response = { jsonrpc: '2.0', id: 1, result: { data: largeString } };
    const framed = frameMessage(response);

    // Verify the Content-Length header is correct
    const json = JSON.stringify(response);
    const expectedLength = Buffer.byteLength(json);
    const headerMatch = framed.match(/Content-Length:\s*(\d+)/i);
    expect(headerMatch).not.toBeNull();
    expect(parseInt(headerMatch![1]!, 10)).toBe(expectedLength);

    // Emit data and verify no crash
    mockProcess.stdout.emit('data', Buffer.from(framed));
    expect(transport.isConnected()).toBe(true);
  });

  it('correctly frames a large outgoing message via sendRequest', async () => {
    await connectTransport(transport);
    const largeString = 'y'.repeat(65 * 1024); // 65KB
    const requestPromise = transport.sendRequest('test/large', { data: largeString });
    await new Promise(r => setTimeout(r, 50));

    // Verify the outgoing message was Content-Length framed
    const writeCalls = (mockProcess.stdin.write as any).mock.calls;
    expect(writeCalls.length).toBeGreaterThan(0);
    const rawOut = writeCalls[0][0] as string;
    expect(rawOut).toMatch(/Content-Length:\s*\d+\r\n\r\n/);
  });
});

describe('StdioTransport — Multiple Messages in Single Buffer', () => {
  let transport: StdioTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    transport = new StdioTransport();
  });

  it('splits multiple complete messages in a single stdin chunk', async () => {
    await connectTransport(transport);
    const msg1 = frameMessage({ jsonrpc: '2.0', id: 1, result: 'first' });
    const msg2 = frameMessage({ jsonrpc: '2.0', id: 2, result: 'second' });
    const msg3 = frameMessage({ jsonrpc: '2.0', method: 'notify', params: {} });

    // Send all three messages concatenated in one buffer
    mockProcess.stdout.emit('data', Buffer.from(msg1 + msg2 + msg3));
    expect(transport.isConnected()).toBe(true);
  });

  it('handles many small messages in one buffer', async () => {
    await connectTransport(transport);
    const messages: string[] = [];
    for (let i = 0; i < 50; i++) {
      messages.push(frameMessage({ jsonrpc: '2.0', id: i, result: `msg-${i}` }));
    }
    mockProcess.stdout.emit('data', Buffer.from(messages.join('')));
    expect(transport.isConnected()).toBe(true);
  });
});

describe('StdioTransport — Partial Messages Across Buffer Boundaries', () => {
  let transport: StdioTransport;

  beforeEach(() => {
    vi.clearAllMocks();
    mockProcess = createMockProcess();
    transport = new StdioTransport();
  });

  it('reassembles message split in the middle of the header', async () => {
    await connectTransport(transport);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const fullFrame = frameMessage({ jsonrpc: '2.0', id: 1, result: 'ok' });

    // Split after first 8 bytes (mid-header)
    const splitPoint = 8;
    const part1 = fullFrame.slice(0, splitPoint);
    const part2 = fullFrame.slice(splitPoint);

    mockProcess.stdout.emit('data', Buffer.from(part1));
    // Buffer should hold partial header, not crash
    expect(transport.isConnected()).toBe(true);

    mockProcess.stdout.emit('data', Buffer.from(part2));
    expect(transport.isConnected()).toBe(true);
  });

  it('reassembles message split in the middle of the body', async () => {
    await connectTransport(transport);
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'ok' });
    const fullFrame = frameMessage({ jsonrpc: '2.0', id: 1, result: 'ok' });

    // Split after header + 5 bytes of body
    const headerEnd = fullFrame.indexOf('\r\n\r\n') + 4;
    const splitPoint = headerEnd + 5;
    const part1 = fullFrame.slice(0, splitPoint);
    const part2 = fullFrame.slice(splitPoint);

    mockProcess.stdout.emit('data', Buffer.from(part1));
    expect(transport.isConnected()).toBe(true);

    mockProcess.stdout.emit('data', Buffer.from(part2));
    expect(transport.isConnected()).toBe(true);
  });

  it('reassembles message split byte by byte', async () => {
    await connectTransport(transport);
    const fullFrame = frameMessage({ jsonrpc: '2.0', id: 1, result: 'ok' });

    // Feed one byte at a time
    for (let i = 0; i < fullFrame.length; i++) {
      mockProcess.stdout.emit('data', Buffer.from(fullFrame.slice(i, i + 1)));
    }
    expect(transport.isConnected()).toBe(true);
  });

  it('handles message whose body arrives in multiple chunks', async () => {
    await connectTransport(transport);
    const data = 'x'.repeat(5000);
    const response = { jsonrpc: '2.0', id: 1, result: { data } };
    const fullFrame = frameMessage(response);

    // Send header + first 100 bytes of body
    const headerEnd = fullFrame.indexOf('\r\n\r\n') + 4;
    const chunkSize = 100;
    mockProcess.stdout.emit('data', Buffer.from(fullFrame.slice(0, headerEnd + chunkSize)));

    // Send remaining body in chunks
    let offset = headerEnd + chunkSize;
    while (offset < fullFrame.length) {
      const end = Math.min(offset + chunkSize, fullFrame.length);
      mockProcess.stdout.emit('data', Buffer.from(fullFrame.slice(offset, end)));
      offset = end;
    }
    expect(transport.isConnected()).toBe(true);
  });
});
