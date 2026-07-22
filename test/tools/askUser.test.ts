import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tool } from '../../src/tools/AskUserTool';
import type { ToolUseContext } from '../../src/tools/protocol';

// Controllable readline answer (hoisted so the mock factory can see it).
const h = vi.hoisted(() => ({ answer: '' }));

vi.mock('node:readline', () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => cb(h.answer),
    close: () => {},
  }),
}));

function makeContext(partial: Partial<ToolUseContext> = {}): ToolUseContext {
  return {
    cwd: process.cwd(),
    abortController: new AbortController(),
    permissions: {} as ToolUseContext['permissions'],
    env: {} as ToolUseContext['env'],
    ...partial,
  };
}

describe('AskUserTool (H4)', () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    h.answer = '';
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    vi.clearAllMocks();
  });

  describe('registered handler (priority)', () => {
    it('routes through context.interaction.ask and returns its answer', async () => {
      const ask = vi.fn().mockResolvedValue('use JWT');
      const ctx = makeContext({ interaction: { ask } });

      const result = await tool.call(
        { question: 'session or JWT?', options: ['session', 'JWT'], default_answer: 'session' },
        ctx
      );

      expect(ask).toHaveBeenCalledWith({
        question: 'session or JWT?',
        options: ['session', 'JWT'],
        default: 'session',
      });
      expect(result.isError).toBe(false);
      expect(result.output).toBe('use JWT');
      expect(result.metadata?.source).toBe('handler');
    });
  });

  describe('TTY blocking read (no handler)', () => {
    beforeEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    });

    it('returns the trimmed typed answer', async () => {
      h.answer = '  hello world  ';
      const result = await tool.call({ question: 'name?' }, makeContext());
      expect(result.isError).toBe(false);
      expect(result.output).toBe('hello world');
      expect(result.metadata?.source).toBe('stdin');
    });

    it('resolves a numeric selection to the matching option', async () => {
      h.answer = '2';
      const result = await tool.call(
        { question: 'pick', options: ['alpha', 'beta', 'gamma'] },
        makeContext()
      );
      expect(result.output).toBe('beta');
    });

    it('falls back to default_answer on empty input', async () => {
      h.answer = '';
      const result = await tool.call(
        { question: 'proceed?', default_answer: 'yes' },
        makeContext()
      );
      expect(result.output).toBe('yes');
    });
  });

  describe('non-interactive fallback (no handler, no TTY)', () => {
    beforeEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    });

    it('returns default_answer when provided', async () => {
      const result = await tool.call(
        { question: 'proceed?', default_answer: 'yes' },
        makeContext()
      );
      expect(result.isError).toBe(false);
      expect(result.output).toBe('yes');
      expect(result.metadata?.source).toBe('default');
    });

    it('fails explicitly (no misleading placeholder) when no default', async () => {
      const result = await tool.call({ question: 'proceed?' }, makeContext());
      expect(result.isError).toBe(true);
      expect(result.message).toBe('interactive input unavailable');
    });
  });

  describe('concurrency', () => {
    it('is not concurrency-safe', () => {
      expect(tool.isConcurrencySafe?.({ question: 'x' })).toBe(false);
    });

    it('is read-only', () => {
      expect(tool.isReadOnly?.({ question: 'x' })).toBe(true);
    });
  });
});
