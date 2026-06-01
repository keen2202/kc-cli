// Chalk-based renderer - entry point for the terminal UI

import type { QueryEngine } from '../query/QueryEngine';
import { runApp } from './components/App';

interface RenderOptions {
  queryEngine: QueryEngine;
  provider?: string;
  model?: string;
  maxTurns?: number;
  themeName?: string;
}

export function renderInkUI(options: RenderOptions): void {
  runApp({
    queryEngine: options.queryEngine,
    provider: options.provider,
    model: options.model,
    maxTurns: options.maxTurns,
    themeName: options.themeName,
  }).catch((error) => {
    console.error('UI error:', error);
    process.exit(1);
  });
}

// ── Performance utilities (exported for testing) ──

/**
 * Throttle function - executes at most once per `interval` ms.
 * The last call within a burst is guaranteed to execute.
 */
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
      // Enough time passed - execute immediately
      lastCallTime = now;
      fn(...args);
    } else {
      // Within throttle window - schedule trailing call
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

/**
 * Debounce function - delays execution until `delayMs` ms of silence.
 */
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
