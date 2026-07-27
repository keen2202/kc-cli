/**
 * StatusBar (StatusBarView) progress bar semantics (T4, ui-runtime-hardening).
 *
 * The bar must follow `progressPercent` when supplied (goal mode reports
 * iteration progress there); previously it always re-derived fill from
 * turnCount, so the bar never moved in goal mode.
 */

import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'ink';
import { StatusBar } from '../../src/ui/components/StatusBarView.js';
import { ThemeProvider } from '../../src/ui/hooks/useTheme';

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const stripAnsi = (s: string) => s.replace(ANSI_PATTERN, '');

class FakeStdout extends EventEmitter {
  public frames: string[] = [];
  public columns = 80;
  public rows = 24;
  public readonly isTTY = true;
  write = (chunk: string): boolean => {
    this.frames.push(chunk);
    return true;
  };
  lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? '';
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function renderStatusBar(props: Partial<React.ComponentProps<typeof StatusBar>> = {}) {
  const stdout = new FakeStdout();
  const instance = render(
    <ThemeProvider>
      <StatusBar
        mode="idle"
        provider="test"
        model="test-model"
        turnCount={0}
        maxTurns={50}
        {...props}
      />
    </ThemeProvider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  await delay(30);
  const frame = stripAnsi(stdout.lastFrame());
  instance.unmount();
  return frame;
}

describe('StatusBar progress bar', () => {
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, 'columns', { value: 80, writable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, writable: true, configurable: true });
  });

  it('fills from progressPercent when provided (goal mode)', async () => {
    // turnCount=0 would render an empty bar — progressPercent must win.
    const frame = await renderStatusBar({ turnCount: 0, maxTurns: 50, progressPercent: 100 });
    expect(frame).toContain('██████████');
    expect(frame).toContain('100%');
  });

  it('renders an empty bar at progressPercent 0 even with turns consumed', async () => {
    const frame = await renderStatusBar({ turnCount: 25, maxTurns: 50, progressPercent: 0 });
    expect(frame).toContain('░░░░░░░░░░');
  });

  it('falls back to turn-based fill without progressPercent', async () => {
    const frame = await renderStatusBar({ turnCount: 25, maxTurns: 50 });
    expect(frame).toContain('█████░░░░░');
  });

  it('clamps out-of-range progressPercent instead of breaking the bar', async () => {
    const frame = await renderStatusBar({ turnCount: 0, maxTurns: 50, progressPercent: 250 });
    expect(frame).toContain('██████████');
  });

  it('renders the overlay mode indicator', async () => {
    const frame = await renderStatusBar({ mode: 'overlay' });
    expect(frame).toContain('◉ overlay');
  });
});
