// React-Ink based renderer for the terminal UI

import { render } from 'ink';
import type { QueryEngine } from '../query/QueryEngine';
import { AppRoot } from './components/AppRoot.js';
import { EXIT } from '../utils/exit-codes';
import type { ResumedSession } from '../bootstrap/init-sequence';

interface RenderOptions {
  queryEngine: QueryEngine;
  provider?: string;
  model?: string;
  maxTurns?: number;
  themeName?: string;
  /** Session restored by kc --continue/--resume before the UI started. */
  resumedSession?: ResumedSession;
}

export function renderInkUI(options: RenderOptions): void {
  const { waitUntilExit } = render(
    <AppRoot
      queryEngine={options.queryEngine}
      provider={options.provider}
      model={options.model}
      maxTurns={options.maxTurns}
      themeName={options.themeName}
      resumedSession={options.resumedSession}
    />,
    {
      stdout: process.stdout,
      stdin: process.stdin,
      // Line-level frame diffing (ink 7). The default (false) erases and
      // rewrites the ENTIRE frame on every render; with the composer's white
      // cursor cell and border that reads as constant flicker — every
      // keystroke, every ~33ms streaming flush, and every status-bar clock
      // tick repainted all frameHeight-1 rows. Incremental mode skips lines
      // whose content is unchanged, so streaming only repaints the chat rows
      // that actually moved and the composer stays visually still.
      incrementalRendering: true,
    },
  );

  // Safety net: if stdin raw mode works but useInput somehow fails,
  // SIGINT (Ctrl+C) will still exit via Ink's default handler.
  // Additional SIGTERM handler for kill signals.
  //
  // R3: SIGTERM reported 0, so a supervisor killing kc-cli could not tell an
  // orderly shutdown from a completed run. 143 = 128 + SIGTERM(15).
  const onTerminate = () => {
    process.exit(EXIT.SIGTERM);
  };
  process.once('SIGTERM', onTerminate);

  waitUntilExit()
    .then(() => {
      process.off('SIGTERM', onTerminate);
    })
    .catch((error) => {
      console.error('UI error:', error);
      process.exit(EXIT.FAILURE);
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
