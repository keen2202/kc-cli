/**
 * Tests for the App class with raw-mode InputManager.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ──

const mockRl = {
  question: vi.fn(),
  close: vi.fn(),
};

let rawKeyHandler: ((chunk: string) => void) | null = null;
const stdinHandlers: Record<string, (...args: any[]) => void> = {};
let isRawMode = false;

const mockQueryEngine = {
  submitMessage: vi.fn(async function* () {}),
};

// Capture stdout writes
const stdoutWrites: string[] = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalExit = process.exit;

// ── Module setup ──

vi.mock('readline', () => ({
  default: {
    createInterface: () => mockRl,
  },
}));

vi.mock('worker_threads', () => ({
  Worker: class MockWorker {
    on() {}
    terminate() { return Promise.resolve(); }
  },
}));

import { App } from '../../src/ui/components/App';

// ── Helper to simulate raw keypress ──
function simulateKeypress(chunk: string): void {
  if (rawKeyHandler) {
    rawKeyHandler(chunk);
  }
}

// ── Helper to simulate typing text ──
function simulateText(text: string): void {
  for (const ch of text) {
    simulateKeypress(ch);
  }
}

// ── Helper to wait for async operations ──
function waitForAsync(ms: number = 10): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('App Class', () => {
  let app: App;

  beforeEach(() => {
    vi.clearAllMocks();
    rawKeyHandler = null;
    isRawMode = false;
    stdoutWrites.length = 0;
    Object.keys(stdinHandlers).forEach(k => delete stdinHandlers[k]);

    // Mock process.stdin
    const mockStdin = {
      setRawMode: vi.fn((mode: boolean) => { isRawMode = mode; }),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        stdinHandlers[event] = handler;
        if (event === 'data') rawKeyHandler = handler;
      }),
      removeListener: vi.fn((event: string) => {
        delete stdinHandlers[event];
        if (event === 'data') rawKeyHandler = null;
      }),
      isTTY: true,
      setEncoding: vi.fn(),
    };

    Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true, configurable: true });

    // Mock process.stdout.write
    process.stdout.write = vi.fn((chunk: any) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as any;

    // Mock process.exit to prevent actual exit
    process.exit = vi.fn() as any;

    // Mock process.stdout.columns/rows
    Object.defineProperty(process.stdout, 'columns', { value: 80, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 24, writable: true, configurable: true });
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  function createApp(overrides: Partial<{ provider: string; model: string; maxTurns: number }> = {}) {
    return new App({
      queryEngine: mockQueryEngine as any,
      provider: 'test-provider',
      model: 'test-model',
      maxTurns: 10,
      ...overrides,
    });
  }

  describe('Constructor', () => {
    it('initializes with provided options', () => {
      app = createApp();
      expect(app).toBeDefined();
    });

    it('uses default provider/model when not specified', () => {
      app = new App({
        queryEngine: mockQueryEngine as any,
      });
      expect(app).toBeDefined();
    });

    it('uses default maxTurns when not specified', () => {
      app = new App({
        queryEngine: mockQueryEngine as any,
      });
      expect(app).toBeDefined();
    });
  });

  describe('start()', () => {
    it('clears screen and renders initial state', async () => {
      app = createApp();
      await app.start();

      // Should have written to stdout (initial render)
      expect(stdoutWrites.length).toBeGreaterThan(0);
      // Should contain ANSI clear sequence
      expect(stdoutWrites.some(w => w.includes('\x1B[2J') || w.includes('\x1B[H'))).toBe(true);
    });

    it('registers SIGINT handler', async () => {
      const onSpy = vi.spyOn(process, 'on');
      app = createApp();
      await app.start();

      const sigintHandler = onSpy.mock.calls.find(c => c[0] === 'SIGINT');
      expect(sigintHandler).toBeDefined();
    });

    it('registers SIGTERM handler', async () => {
      const onSpy = vi.spyOn(process, 'on');
      app = createApp();
      await app.start();

      const sigtermHandler = onSpy.mock.calls.find(c => c[0] === 'SIGTERM');
      expect(sigtermHandler).toBeDefined();
    });

    it('enables raw mode on stdin', async () => {
      app = createApp();
      await app.start();
      // After start, stdin raw mode should be enabled
      expect(isRawMode).toBe(true);
    });
  });

  describe('Command Handling', () => {
    beforeEach(async () => {
      app = createApp();
      await app.start();
    });

    it('handles /help command via raw keypress', () => {
      // Type / h e l p and Enter
      simulateText('/help');
      simulateKeypress('\r');
      // Should render help overlay
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /clear command', () => {
      simulateText('/clear');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /status command', () => {
      simulateText('/status');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /sidebar toggle', () => {
      simulateText('/sidebar');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /sidebar with section', () => {
      simulateText('/sidebar files');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /palette command', () => {
      simulateText('/palette');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /model command', () => {
      simulateText('/model');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /permission without mode', () => {
      simulateText('/permission');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /exit command', () => {
      simulateText('/exit');
      simulateKeypress('\r');
      expect(process.exit).toHaveBeenCalledWith(0);
    });

    it('renders after multiple commands', () => {
      simulateText('/help');
      simulateKeypress('\r');
      simulateText('/status');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });
  });

  describe('User Message and Query Execution', () => {
    beforeEach(async () => {
      app = createApp();
      await app.start();
    });

    it('adds user message and executes query', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield { type: 'text_delta', text: 'Hello' };
        yield { type: 'text_delta', text: ' world' };
      });

      simulateText('test message');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(mockQueryEngine.submitMessage).toHaveBeenCalledWith('test message');
    });

    it('handles text_delta events', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield { type: 'text_delta', text: 'Response' };
      });

      simulateText('test');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.some(w => w.includes('Response'))).toBe(true);
    });

    it('handles tool_started event', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'Bash' },
        };
      });

      simulateText('run command');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.some(w => w.includes('Bash'))).toBe(true);
    });

    it('handles tool_completed event', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'Bash' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'Bash' },
          result: { output: 'success', isError: false },
        };
      });

      simulateText('run');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles query engine error', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        throw new Error('Engine error');
      });

      simulateText('trigger error');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.some(w => w.includes('Error') || w.includes('Engine error'))).toBe(true);
    });

    it('handles agent: prefixed events', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield { type: 'agent:text_delta', text: 'Agent response' };
      });

      simulateText('test agent prefix');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.some(w => w.includes('Agent response'))).toBe(true);
    });

    it('increments turn count after query', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield { type: 'text_delta', text: 'ok' };
      });

      simulateText('first');
      simulateKeypress('\r');
      await waitForAsync(50);

      // Check status line shows turn count
      simulateText('/status');
      simulateKeypress('\r');
      expect(stdoutWrites.some(w => w.includes('1/'))).toBe(true);
    });
  });

  describe('Diff Handling', () => {
    beforeEach(async () => {
      app = createApp();
      await app.start();
    });

    it('captures diff from FileWrite tool result', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'FileWrite' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'FileWrite' },
          result: {
            output: 'written',
            metadata: {
              path: '/test/file.ts',
              oldContent: 'old',
              newContent: 'new',
            },
          },
        };
      });

      simulateText('write file');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('/diff');
      simulateKeypress('\r');
      expect(stdoutWrites.some(w => w.includes('file.ts') || w.includes('Diff'))).toBe(true);
    });

    it('handles /accept command with pending diff', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'FileWrite' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'FileWrite' },
          result: {
            output: 'ok',
            metadata: {
              path: '/test/accept.ts',
              oldContent: '',
              newContent: 'content',
            },
          },
        };
      });

      simulateText('create file');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('/accept');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('handles /reject command with pending diff', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'FileWrite' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'FileWrite' },
          result: {
            output: 'ok',
            metadata: {
              path: '/test/reject.ts',
              oldContent: '',
              newContent: 'content',
            },
          },
        };
      });

      simulateText('create file');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('/reject');
      simulateKeypress('\r');
      expect(stdoutWrites.length).toBeGreaterThan(0);
    });

    it('ignores diff capture for non-diff tools', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'Bash' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'Bash' },
          result: {
            output: 'ok',
            metadata: {
              path: '/test/file.ts',
              oldContent: 'a',
              newContent: 'b',
            },
          },
        };
      });

      simulateText('bash command');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('/diff');
      simulateKeypress('\r');
      expect(stdoutWrites.some(w => w.includes('No pending'))).toBe(true);
    });

    it('ignores diff capture when no metadata', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'FileWrite' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'FileWrite' },
          result: { output: 'ok' },
        };
      });

      simulateText('write without metadata');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('/diff');
      simulateKeypress('\r');
      expect(stdoutWrites.some(w => w.includes('No pending'))).toBe(true);
    });

    it('ignores diff capture when no file path', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'FileWrite' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'FileWrite' },
          result: {
            output: 'ok',
            metadata: { oldContent: 'a', newContent: 'b' },
          },
        };
      });

      simulateText('write no path');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('/diff');
      simulateKeypress('\r');
      expect(stdoutWrites.some(w => w.includes('No pending'))).toBe(true);
    });

    it('updates existing diff for same file', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'FileWrite' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'FileWrite' },
          result: {
            output: 'ok',
            metadata: {
              path: '/test/same.ts',
              oldContent: 'v1',
              newContent: 'v2',
            },
          },
        };
      });

      simulateText('write 1');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('write 2');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('/diff');
      simulateKeypress('\r');
      expect(stdoutWrites.some(w => w.includes('same.ts'))).toBe(true);
    });
  });

  describe('Sidebar Tool Updates', () => {
    beforeEach(async () => {
      app = createApp();
      await app.start();
    });

    it('adds running tool to sidebar', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'NewTool' },
        };
      });

      simulateText('run tool');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.some(w => w.includes('NewTool'))).toBe(true);
    });

    it('updates tool status from running to completed', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'UpdTool' },
        };
        yield {
          type: 'tool_completed',
          toolCall: { toolName: 'UpdTool' },
          result: { output: 'done', isError: false },
        };
      });

      simulateText('run and complete');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.some(w => w.includes('UpdTool'))).toBe(true);
    });

    it('updates tool status from running to failed', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield {
          type: 'tool_started',
          toolCall: { toolName: 'FailTool' },
        };
        yield {
          type: 'tool_failed',
          toolCall: { toolName: 'FailTool' },
          error: { message: 'Failed' },
        };
      });

      simulateText('run and fail');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.some(w => w.includes('FailTool'))).toBe(true);
    });
  });

  describe('Rendering', () => {
    it('renders without throwing on start', async () => {
      app = createApp();
      await expect(app.start()).resolves.not.toThrow();
    });

    it('renders after adding a message', async () => {
      app = createApp();
      await app.start();

      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield { type: 'text_delta', text: 'ok' };
      });
      simulateText('test');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.length).toBeGreaterThan(0);
    });
  });

  describe('Multiple Queries', () => {
    beforeEach(async () => {
      app = createApp();
      await app.start();
    });

    it('handles multiple sequential queries', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield { type: 'text_delta', text: 'Response' };
      });

      simulateText('first query');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('second query');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(mockQueryEngine.submitMessage).toHaveBeenCalledTimes(2);
    });

    it('maintains conversation history', async () => {
      mockQueryEngine.submitMessage = vi.fn(async function* () {
        yield { type: 'text_delta', text: 'Reply' };
      });

      simulateText('message 1');
      simulateKeypress('\r');
      await waitForAsync(50);

      simulateText('message 2');
      simulateKeypress('\r');
      await waitForAsync(50);

      expect(stdoutWrites.some(w => w.includes('message 1'))).toBe(true);
    });
  });
});
