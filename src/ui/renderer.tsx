// React-Ink based renderer for the terminal UI

import { render } from 'ink';
import type { QueryEngine } from '../query/QueryEngine';
import { AppRoot } from './components/AppRoot.js';

interface RenderOptions {
  queryEngine: QueryEngine;
  provider?: string;
  model?: string;
  maxTurns?: number;
  themeName?: string;
}

export function renderInkUI(options: RenderOptions): void {
  const { waitUntilExit } = render(
    <AppRoot
      queryEngine={options.queryEngine}
      provider={options.provider}
      model={options.model}
      maxTurns={options.maxTurns}
      themeName={options.themeName}
    />,
    {
      stdout: process.stdout,
      stdin: process.stdin,
    },
  );

  // Safety net: if stdin raw mode works but useInput somehow fails,
  // SIGINT (Ctrl+C) will still exit via Ink's default handler.
  // Additional SIGTERM handler for kill signals.
  const onTerminate = () => {
    process.exit(0);
  };
  process.once('SIGTERM', onTerminate);

  waitUntilExit()
    .then(() => {
      process.off('SIGTERM', onTerminate);
    })
    .catch((error) => {
      console.error('UI error:', error);
      process.exit(1);
    });
}

// ── Performance utilities (preserved for testing compatibility) ──

export function createThrottle<T extends (...args: any[]) => void>(
  fn: T,
  intervalMs: number,
): T & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] | null = null;
  let lastCallTime = 0;

  const throttled = ((...args: any[]) => {
    const now = Date.now();
    const elapsed = now - lastCallTime;

    if (elapsed >= intervalMs) {
      lastCallTime = now;
      fn(...args);
    } else {
      lastArgs = args;
      if (!timer) {
        const remaining = intervalMs - elapsed;
        timer = setTimeout(() => {
          timer = null;
          lastCallTime = Date.now();
          if (lastArgs) {
            fn(...lastArgs);
            lastArgs = null;
          }
        }, remaining);
      }
    }
  }) as any;

  throttled.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) {
      fn(...lastArgs);
      lastArgs = null;
    }
  };

  return throttled;
}

export function createDebounce<T extends (...args: any[]) => void>(
  fn: T,
  delayMs: number,
): T & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: any[] | null = null;

  const debounced = ((...args: any[]) => {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (lastArgs) {
        fn(...lastArgs);
        lastArgs = null;
      }
    }, delayMs);
  }) as any;

  debounced.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    lastArgs = null;
  };

  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lastArgs) {
      fn(...lastArgs);
      lastArgs = null;
    }
  };

  return debounced;
}
