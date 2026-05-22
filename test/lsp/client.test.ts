// Tests for LSP Client Manager and detectLanguage

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Mock child_process before importing the module using vi.hoisted
const { mockSpawn } = vi.hoisted(() => {
  const mockSpawn = vi.fn();
  return { mockSpawn };
});

vi.mock('child_process', () => ({
  spawn: mockSpawn,
}));

import { LSPClientManager, detectLanguage } from '../../src/lsp/client';

/**
 * Create a mock ChildProcess with controllable stdin/stdout.
 */
function createMockProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();

  (emitter as any).stdin = stdin;
  (emitter as any).stdout = stdout;
  (emitter as any).stderr = stderr;
  (emitter as any).kill = vi.fn().mockReturnValue(true);

  return { proc: emitter as any, stdin, stdout, stderr };
}

/**
 * Build a raw LSP message with Content-Length header.
 */
function buildLspMessage(obj: object): Buffer {
  const body = JSON.stringify(obj);
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  return Buffer.from(header + body);
}

/**
 * Helper to connect a language, sending initialize request and receiving the response.
 * Returns the stdin stream for further assertions.
 */
async function connectLanguage(
  manager: LSPClientManager,
  languageId: string,
  rootUri: string,
): Promise<{ proc: EventEmitter; stdin: PassThrough; stdout: PassThrough }> {
  const { proc, stdin, stdout } = createMockProcess();
  mockSpawn.mockReturnValue(proc);

  const chunks: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

  const connectPromise = manager.connect(languageId as any, rootUri);
  await new Promise((r) => setTimeout(r, 20));

  const initData = Buffer.concat(chunks).toString();
  chunks.length = 0;
  const initMatch = initData.match(/\r\n\r\n(.+)$/s);
  if (!initMatch) throw new Error('No initialize message found');
  const initParsed = JSON.parse(initMatch[1]);
  stdout.write(buildLspMessage({ jsonrpc: '2.0', id: initParsed.id, result: { capabilities: {} } }));
  await connectPromise;

  return { proc, stdin, stdout };
}

describe('detectLanguage', () => {
  it('should detect .ts as typescript', () => {
    expect(detectLanguage('file.ts')).toBe('typescript');
  });

  it('should detect .tsx as typescript', () => {
    expect(detectLanguage('Component.tsx')).toBe('typescript');
  });

  it('should detect .js as javascript', () => {
    expect(detectLanguage('file.js')).toBe('javascript');
  });

  it('should detect .jsx as javascript', () => {
    expect(detectLanguage('Component.jsx')).toBe('javascript');
  });

  it('should detect .go as go', () => {
    expect(detectLanguage('main.go')).toBe('go');
  });

  it('should detect .py as python', () => {
    expect(detectLanguage('script.py')).toBe('python');
  });

  it('should detect .rs as rust', () => {
    expect(detectLanguage('lib.rs')).toBe('rust');
  });

  it('should return unknown for unrecognized extensions', () => {
    expect(detectLanguage('file.txt')).toBe('unknown');
    expect(detectLanguage('file.md')).toBe('unknown');
    expect(detectLanguage('Makefile')).toBe('unknown');
  });

  it('should handle full paths', () => {
    expect(detectLanguage('/usr/local/bin/script.ts')).toBe('typescript');
    expect(detectLanguage('/home/user/project/main.go')).toBe('go');
  });

  it('should be case-insensitive on extensions', () => {
    expect(detectLanguage('file.TS')).toBe('typescript');
    expect(detectLanguage('file.PY')).toBe('python');
  });

  it('should handle files with multiple dots', () => {
    expect(detectLanguage('file.spec.ts')).toBe('typescript');
    expect(detectLanguage('test.unit.js')).toBe('javascript');
  });
});

describe('LSPClientManager', () => {
  let manager: LSPClientManager;

  beforeEach(() => {
    manager = new LSPClientManager();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.disconnectAll();
  });

  describe('connect', () => {
    it('should return false for unknown language (empty command)', async () => {
      const result = await manager.connect('unknown', 'file:///workspace');
      expect(result).toBe(false);
    });

    it('should spawn a process and initialize for a known language', async () => {
      const { proc, stdin, stdout } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const connectPromise = manager.connect('typescript', 'file:///workspace');
      await new Promise((r) => setTimeout(r, 20));

      const initData = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const initMatch = initData.match(/\r\n\r\n(.+)$/s);
      expect(initMatch).not.toBeNull();
      const parsed = JSON.parse(initMatch![1]);
      expect(parsed.method).toBe('initialize');

      stdout.write(buildLspMessage({ jsonrpc: '2.0', id: parsed.id, result: { capabilities: {} } }));

      const result = await connectPromise;
      expect(result).toBe(true);
      expect(manager.isConnected('typescript')).toBe(true);
    });

    it('should return true if already connected', async () => {
      await connectLanguage(manager, 'go', 'file:///workspace');
      const result = await manager.connect('go', 'file:///workspace');
      expect(result).toBe(true);
    });

    it('should handle spawn throwing an error', async () => {
      mockSpawn.mockImplementation(() => { throw new Error('spawn failed'); });
      const result = await manager.connect('python', 'file:///workspace');
      expect(result).toBe(false);
    });
  });

  describe('isConnected', () => {
    it('should return false when no servers connected', () => {
      expect(manager.isConnected('typescript')).toBe(false);
    });
  });

  describe('disconnectAll', () => {
    it('should kill all processes and clear state', async () => {
      const { proc } = await connectLanguage(manager, 'typescript', 'file:///workspace');
      expect(manager.isConnected('typescript')).toBe(true);
      await manager.disconnectAll();
      expect(manager.isConnected('typescript')).toBe(false);
      expect((proc as any).kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should handle kill errors gracefully', async () => {
      const { proc } = await connectLanguage(manager, 'typescript', 'file:///workspace');
      ((proc as any).kill as any).mockImplementation(() => { throw new Error('already dead'); });
      await expect(manager.disconnectAll()).resolves.not.toThrow();
    });
  });

  describe('request', () => {
    it('should return null if server not connected', async () => {
      const result = await manager.request('/test/file.ts', 'textDocument/hover', {});
      expect(result).toBeNull();
    });

    it('should send request and return result when connected', async () => {
      const { stdin, stdout } = await connectLanguage(manager, 'typescript', 'file:///workspace');

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const reqPromise = manager.request('/test/file.ts', 'textDocument/hover', {
        textDocument: { uri: 'file:///test/file.ts' },
        position: { line: 0, character: 0 },
      });

      await new Promise((r) => setTimeout(r, 20));
      const reqData = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const reqMatch = reqData.match(/\r\n\r\n(.+)$/s);
      expect(reqMatch).not.toBeNull();
      const reqParsed = JSON.parse(reqMatch![1]);
      expect(reqParsed.method).toBe('textDocument/hover');

      const hoverResult = { contents: 'Type: string' };
      stdout.write(buildLspMessage({ jsonrpc: '2.0', id: reqParsed.id, result: hoverResult }));

      const result = await reqPromise;
      expect(result).toEqual(hoverResult);
    });
  });

  describe('getHover', () => {
    it('should return null if server not connected', async () => {
      const result = await manager.getHover('/test/file.ts', 'const x = 1;', 0, 0);
      expect(result).toBeNull();
    });
  });

  describe('getDefinition', () => {
    it('should return empty array if server not connected', async () => {
      const result = await manager.getDefinition('/test/file.ts', 'const x = 1;', 0, 0);
      expect(result).toEqual([]);
    });

    it('should handle single location result (not array)', async () => {
      const { stdin, stdout } = await connectLanguage(manager, 'typescript', 'file:///workspace');

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const defPromise = manager.getDefinition('/test/file.ts', 'const x = 1;', 0, 5);
      await new Promise((r) => setTimeout(r, 20));

      // Read the didOpen message
      const data1 = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const match1 = data1.match(/\r\n\r\n(.+)$/s);
      if (match1) {
        const parsed1 = JSON.parse(match1[1]);
        stdout.write(buildLspMessage({ jsonrpc: '2.0', id: parsed1.id, result: null }));
      }

      await new Promise((r) => setTimeout(r, 20));
      const data2 = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const match2 = data2.match(/\r\n\r\n(.+)$/s);

      if (match2) {
        const parsed2 = JSON.parse(match2[1]);
        const singleLocation = { uri: 'file:///test/file.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } };
        stdout.write(buildLspMessage({ jsonrpc: '2.0', id: parsed2.id, result: singleLocation }));
      }

      const result = await defPromise;
      expect(result).toHaveLength(1);
    });

    it('should return empty array on error', async () => {
      const { stdin, stdout } = await connectLanguage(manager, 'typescript', 'file:///workspace');

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const defPromise = manager.getDefinition('/test/file.ts', 'const x = 1;', 0, 5);
      await new Promise((r) => setTimeout(r, 20));

      const data1 = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const match1 = data1.match(/\r\n\r\n(.+)$/s);
      if (match1) {
        const parsed1 = JSON.parse(match1[1]);
        // Send error for didOpen
        stdout.write(buildLspMessage({ jsonrpc: '2.0', id: parsed1.id, error: { code: -1, message: 'fail' } }));
      }

      const result = await defPromise;
      expect(result).toEqual([]);
    });
  });

  describe('getDiagnostics', () => {
    it('should return empty if server not connected', async () => {
      const result = await manager.getDiagnostics('/test/file.ts', 'const x = 1;');
      expect(result).toEqual([]);
    });

    it('should return cached diagnostics if available', async () => {
      const { stdout } = await connectLanguage(manager, 'typescript', 'file:///workspace');

      const diagnostics = [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'error' }];
      stdout.write(buildLspMessage({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///test/file.ts', diagnostics },
      }));

      await new Promise((r) => setTimeout(r, 50));

      const result = await manager.getDiagnostics('/test/file.ts', 'const x = 1;');
      expect(result).toEqual(diagnostics);
    });
  });

  describe('processBuffer', () => {
    it('should not crash when receiving data without Content-Length header', async () => {
      // Successfully connect first
      const { stdout } = await connectLanguage(manager, 'typescript', 'file:///workspace');

      // Write garbage data to stdout - should not crash the process
      expect(() => {
        stdout.write(Buffer.from('garbage data\r\n\r\n'));
      }).not.toThrow();

      // Verify the manager is still in a valid state
      expect(manager.isConnected('typescript')).toBe(true);
    });

    it('should handle partial messages (incomplete buffer)', async () => {
      const { proc, stdin, stdout } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const connectPromise = manager.connect('typescript', 'file:///workspace');
      await new Promise((r) => setTimeout(r, 20));
      const initData = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const initMatch = initData.match(/\r\n\r\n(.+)$/s);
      const initParsed = JSON.parse(initMatch![1]);

      // Write partial message
      const fullMsg = buildLspMessage({ jsonrpc: '2.0', id: initParsed.id, result: { capabilities: {} } });
      stdout.write(fullMsg.slice(0, 10));
      await new Promise((r) => setTimeout(r, 20));
      stdout.write(fullMsg.slice(10));

      const result = await connectPromise;
      expect(result).toBe(true);
    });

    it('should handle invalid JSON in message body', async () => {
      const { proc, stdin, stdout } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const connectPromise = manager.connect('typescript', 'file:///workspace');
      await new Promise((r) => setTimeout(r, 20));
      const initData = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const initMatch = initData.match(/\r\n\r\n(.+)$/s);
      const initParsed = JSON.parse(initMatch![1]);

      // Write invalid JSON with proper Content-Length
      const invalidJson = '{invalid json}';
      const header = `Content-Length: ${Buffer.byteLength(invalidJson)}\r\n\r\n`;
      stdout.write(Buffer.from(header + invalidJson));
      // Then the valid response
      stdout.write(buildLspMessage({ jsonrpc: '2.0', id: initParsed.id, result: { capabilities: {} } }));

      const result = await connectPromise;
      expect(result).toBe(true);
    });
  });

  describe('handleMessage', () => {
    it('should handle error responses', async () => {
      const { stdin, stdout } = await connectLanguage(manager, 'typescript', 'file:///workspace');

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const reqPromise = manager.request('/test/file.ts', 'textDocument/hover', {});
      await new Promise((r) => setTimeout(r, 20));
      const reqData = Buffer.concat(chunks).toString();
      const reqMatch = reqData.match(/\r\n\r\n(.+)$/s);
      if (reqMatch) {
        const reqParsed = JSON.parse(reqMatch[1]);
        stdout.write(buildLspMessage({
          jsonrpc: '2.0',
          id: reqParsed.id,
          error: { code: -32600, message: 'Invalid Request' },
        }));
      }

      await expect(reqPromise).rejects.toThrow('LSP error -32600: Invalid Request');
    });

    it('should handle publishDiagnostics notifications', async () => {
      const { stdout } = await connectLanguage(manager, 'typescript', 'file:///workspace');

      const diagnostics = [
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, severity: 2, message: 'warning' },
      ];
      stdout.write(buildLspMessage({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///test/file.ts', diagnostics },
      }));

      await new Promise((r) => setTimeout(r, 50));

      const result = await manager.getDiagnostics('/test/file.ts', 'content');
      expect(result).toEqual(diagnostics);
    });
  });

  describe('process exit and error', () => {
    it('should remove server on process exit', async () => {
      const { proc } = await connectLanguage(manager, 'typescript', 'file:///workspace');
      expect(manager.isConnected('typescript')).toBe(true);

      proc.emit('exit', 0);
      expect(manager.isConnected('typescript')).toBe(false);
    });

    it('should remove server on process error', async () => {
      const { proc } = await connectLanguage(manager, 'typescript', 'file:///workspace');
      expect(manager.isConnected('typescript')).toBe(true);

      proc.emit('error', new Error('crash'));
      expect(manager.isConnected('typescript')).toBe(false);
    });
  });

  describe('sendNotification', () => {
    it('should write notification during connect', async () => {
      const { proc, stdin } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      const connectPromise = manager.connect('typescript', 'file:///workspace');
      await new Promise((r) => setTimeout(r, 20));
      const initData = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const initMatch = initData.match(/\r\n\r\n(.+)$/s);
      const initParsed = JSON.parse(initMatch![1]);
      (proc.stdout as any).write(buildLspMessage({ jsonrpc: '2.0', id: initParsed.id, result: { capabilities: {} } }));
      await connectPromise;

      // The initialized notification should have been sent after initialize response
      // We verify by checking the total data written to stdin after initialize
      await new Promise((r) => setTimeout(r, 20));
      const allData = Buffer.concat(chunks).toString();
      // Should contain 'initialized' method in the second message
      expect(allData).toContain('initialized');
    });
  });

  describe('request timeout', () => {
    it('should reject with timeout error when no response received', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const { proc, stdin, stdout } = createMockProcess();
      mockSpawn.mockReturnValue(proc);

      const chunks: Buffer[] = [];
      stdin.on('data', (chunk: Buffer) => chunks.push(chunk));

      // Connect normally with real timers
      vi.useRealTimers();
      const connectPromise = manager.connect('typescript', 'file:///workspace');
      await new Promise((r) => setTimeout(r, 20));
      const initData = Buffer.concat(chunks).toString();
      chunks.length = 0;
      const initMatch = initData.match(/\r\n\r\n(.+)$/s);
      const initParsed = JSON.parse(initMatch![1]);
      stdout.write(buildLspMessage({ jsonrpc: '2.0', id: initParsed.id, result: { capabilities: {} } }));
      await connectPromise;

      // Now use fake timers for the timeout test
      vi.useFakeTimers({ shouldAdvanceTime: true });

      const reqPromise = manager.request('/test/file.ts', 'textDocument/hover', {});

      // Advance past the 10-second timeout
      vi.advanceTimersByTime(10001);

      await expect(reqPromise).rejects.toThrow('LSP request textDocument/hover timed out');

      vi.useRealTimers();
    });
  });
});
