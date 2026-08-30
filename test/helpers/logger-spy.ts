// Logger spy helper — round4 §7.3
//
// Intercepts the shared logger namespaces so tests can assert on calls and
// payload fields without touching stderr. All spies are installed via vi.spyOn
// and restored by `restoreAllMocks` in the caller (or `stop()` here).

import { vi } from 'vitest';
import { logger } from '../../src/services/logger';

export type LoggerNamespace = keyof typeof logger;

export interface LogCall {
  message: string;
  data?: Record<string, unknown>;
  /** All arguments joined for convenient `toContain` assertions. */
  text: string;
}

export interface LoggerSpy {
  calls: LogCall[];
  /** Reset recorded calls (keeps the spies installed). */
  reset(): void;
  /** Restore the original logger methods. */
  stop(): void;
}

/**
 * Spy on the given logger methods (defaults to every level of one namespace).
 *
 *   const spy = spyOnLogger('api', ['error', 'warn']);
 *   ... trigger code ...
 *   expect(spy.calls[0]).toMatchObject({ message: 'llm request failed' });
 */
export function spyOnLogger(
  namespace: LoggerNamespace,
  levels: Array<'debug' | 'info' | 'warn' | 'error'> = ['debug', 'info', 'warn', 'error'],
): LoggerSpy {
  const ns = logger[namespace] as unknown as Record<
    string,
    (message: string, data?: unknown) => void
  >;
  const calls: LogCall[] = [];
  const mocks: Array<ReturnType<typeof vi.spyOn>> = [];

  for (const level of levels) {
    const original = ns[level];
    if (typeof original !== 'function') continue;
    const mock = vi.spyOn(ns, level).mockImplementation((message: string, data?: unknown) => {
      const dataObj = data && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
      calls.push({
        message,
        data: dataObj,
        text: `${message} ${dataObj ? JSON.stringify(dataObj) : ''}`,
      });
    });
    mocks.push(mock);
  }

  return {
    calls,
    reset() {
      calls.length = 0;
    },
    stop() {
      for (const mock of mocks) mock.mockRestore();
    },
  };
}
