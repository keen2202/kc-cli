/**
 * Behavioral test harness — renders the REAL AppRoot component tree against a
 * fake terminal (fixed stdout size, scriptable stdin) and a fake QueryEngine.
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.0.1 (T0).
 *
 * Note on ink-testing-library: the spec allows falling back to `ink`'s own
 * `render` + a hand-rolled stdout stub when the library is unsuitable. We use
 * the fallback because ink-testing-library hard-codes the fake stdout to 100
 * columns, while the layout-anchor/overflow matrices require arbitrary
 * (width, height) combinations. The harness interface matches the spec.
 */

import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { AppRoot } from '../../../src/ui/components/AppRoot';
import { initializeState, resetState } from '../../../src/bootstrap/state';
import type { QueryEngine } from '../../../src/query/QueryEngine';
import type { UIPermissionRequest } from '../../../src/permissions/protocol';

// ── ANSI / frame utilities ──

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

/** Split a frame into plain-text lines with trailing blank lines removed. */
export function frameLines(frame: string): string[] {
  const lines = stripAnsi(frame).split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  return lines;
}

/** Last non-empty line of a frame ('' when the frame is empty). */
export function lastNonEmptyLine(frame: string): string {
  const lines = frameLines(frame);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') return lines[i]!;
  }
  return '';
}

// ── Fake stdout / stdin ──

class FakeStdout extends EventEmitter {
  public frames: string[] = [];
  public columns: number;
  public rows: number;
  public readonly isTTY = true;

  constructor(columns: number, rows: number) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write = (chunk: string): boolean => {
    // Terminal mode switches (bracketed-paste enable/disable, emitted by
    // ink's usePaste) are not rendered frames — recording them would make
    // lastFrame() return a bare control sequence.
    if (/^\u001B\[\?2004[hl]$/.test(chunk)) return true;
    this.frames.push(chunk);
    return true;
  };

  lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? '';
  }
}

class FakeStdin extends EventEmitter {
  public readonly isTTY = true;
  private queue: string[] = [];

  /** Queue a chunk and signal ink's 'readable' listener. */
  push(chunk: string): void {
    this.queue.push(chunk);
    this.emit('readable');
  }

  read = (): string | null => this.queue.shift() ?? null;
  setEncoding = () => this;
  setRawMode = () => this;
  ref = () => this;
  unref = () => this;
  resume = () => this;
  pause = () => this;
}

// ── Fake QueryEngine ──

type EngineEvent = Record<string, unknown> & { type: string };

/**
 * Minimal QueryEngine stand-in covering the surface AppRoot touches.
 * `script` supplies the events yielded by the next submitMessage call;
 * `gate` (when set) makes the generator suspend until released, keeping the
 * turn "streaming" so goal-mode / streaming states can be observed.
 */
export class FakeQueryEngine {
  public permissionHandler: ((req: UIPermissionRequest) => Promise<string>) | null = null;
  public submittedMessages: string[] = [];
  /** Number of submitMessage() generators that ran to completion. */
  public completedTurns = 0;
  private script: EngineEvent[] = [];
  private gateResolve: (() => void) | null = null;
  private gatePromise: Promise<void> | null = null;

  /** Events the next submitMessage() call will yield. */
  scriptEvents(events: EngineEvent[]): void {
    this.script = events;
  }

  /** Make the next turn hang (streaming) until releaseGate() is called. */
  holdNextTurn(): void {
    this.gatePromise = new Promise<void>((resolve) => {
      this.gateResolve = resolve;
    });
  }

  releaseGate(): void {
    this.gateResolve?.();
    this.gateResolve = null;
    this.gatePromise = null;
  }

  setPermissionRequestHandler(handler: ((req: UIPermissionRequest) => Promise<string>) | null): void {
    this.permissionHandler = handler as typeof this.permissionHandler;
  }

  /** Trigger a pending permission request as the executor would. */
  requestPermission(req: Partial<UIPermissionRequest> & { toolName: string }): Promise<string> {
    if (!this.permissionHandler) throw new Error('No permission handler registered');
    return this.permissionHandler(req as UIPermissionRequest);
  }

  async *submitMessage(text: string): AsyncGenerator<EngineEvent> {
    this.submittedMessages.push(text);
    const gate = this.gatePromise;
    const events = this.script;
    this.script = [];
    for (const event of events) {
      // Optional pacing (stripped before emit) so transport-level tests can
      // spread deltas across several 33ms flush windows instead of one
      // coalesced burst; content-level tests simply never set it.
      const { delayBeforeMs, ...payload } = event as EngineEvent & { delayBeforeMs?: number };
      if (typeof delayBeforeMs === 'number' && delayBeforeMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayBeforeMs));
      }
      yield payload as EngineEvent;
    }
    if (gate) await gate;
    this.completedTurns++;
  }

  getMessages(): unknown[] { return []; }
  setApiKey(_key: string): string | null { return null; }
  clear(): void {}
  setModel(name: string): string { return name; }
  restoreSession(): number { return 0; }
}

// ── process.stdout patch ──
// useTerminalSize / Editor / StatusBar read process.stdout.columns|rows
// directly (not ink's stdout context), so the harness must pin them too.

function patchProcessStdoutSize(columns: number, rows: number): () => void {
  const colDesc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rowDesc = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true });
  return () => {
    if (colDesc) Object.defineProperty(process.stdout, 'columns', colDesc);
    else delete (process.stdout as unknown as Record<string, unknown>)['columns'];
    if (rowDesc) Object.defineProperty(process.stdout, 'rows', rowDesc);
    else delete (process.stdout as unknown as Record<string, unknown>)['rows'];
  };
}

// ── Key chords ──

export const KEYS = {
  escape: '\u001B',
  enter: '\r',
  ctrlJ: '\n',
  tab: '\t',
  ctrlK: '\u000B',
  ctrlO: '\u000F',
  ctrlC: '\u0003',
  up: '\u001B[A',
  down: '\u001B[B',
} as const;

// ── Harness ──

export interface HarnessOptions {
  width?: number;
  height?: number;
  engine?: FakeQueryEngine;
  provider?: string;
  model?: string;
  maxTurns?: number;
  /** Session restored before render — seeded into the transcript once. */
  resumedSession?: { sessionId: string; messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>; turnCount: number };
  /** Override ink render options. The default (`debug: true`) writes full
   *  unthrottled frames, which is what frame-content assertions want; frame-
   *  transport tests (diff/erase behavior) pass `debug: false` plus the
   *  production `incrementalRendering` value to exercise the real write path. */
  renderOptions?: { debug?: boolean; incrementalRendering?: boolean };
}

export interface Harness {
  engine: FakeQueryEngine;
  /** Latest rendered frame (raw, may contain ANSI codes). */
  frame(): string;
  /** Latest rendered frame with ANSI stripped. */
  plainFrame(): string;
  lines(): string[];
  /** Every chunk written to the fake stdout so far (raw transport stream). */
  rawFrames(): string[];
  /** Type a raw chunk (printable text or a KEYS chord). */
  press(chunk: string): Promise<void>;
  /** Type printable text one character at a time. */
  type(text: string): Promise<void>;
  /** Poll until the predicate passes (or fail with the last frame). */
  waitFor(predicate: () => boolean, timeoutMs?: number, label?: string): Promise<void>;
  /** Wait until the plain frame contains the given text. */
  waitForText(text: string, timeoutMs?: number): Promise<void>;
  unmount(): void;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function renderApp(options: HarnessOptions = {}): Promise<Harness> {
  const width = options.width ?? 80;
  const height = options.height ?? 24;
  const engine = options.engine ?? new FakeQueryEngine();

  resetState();
  initializeState({ sessionId: 'test-session', permissionMode: 'default' });

  const restoreStdout = patchProcessStdoutSize(width, height);
  const stdout = new FakeStdout(width, height);
  const stdin = new FakeStdin();

  const instance = render(
    <AppRoot
      queryEngine={engine as unknown as QueryEngine}
      provider={options.provider ?? 'test-provider'}
      model={options.model ?? 'test-model'}
      maxTurns={options.maxTurns ?? 50}
      resumedSession={options.resumedSession}
    />,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: options.renderOptions?.debug ?? true,
      incrementalRendering: options.renderOptions?.incrementalRendering,
      exitOnCtrlC: false,
      patchConsole: false,
    },
  );

  let unmounted = false;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true;
    instance.unmount();
    restoreStdout();
    resetState();
  };

  const harness: Harness = {
    engine,
    frame: () => stdout.lastFrame(),
    plainFrame: () => stripAnsi(stdout.lastFrame()),
    lines: () => frameLines(stdout.lastFrame()),
    rawFrames: () => [...stdout.frames],
    press: async (chunk: string) => {
      stdin.push(chunk);
      // Bare ESC is buffered by ink's input parser (escape-sequence
      // disambiguation) and flushed on a short timer; give it room.
      await delay(chunk === KEYS.escape ? 120 : 30);
    },
    type: async (text: string) => {
      for (const ch of text) {
        stdin.push(ch);
        await delay(5);
      }
      await delay(30);
    },
    waitFor: async (predicate, timeoutMs = 3000, label = 'condition') => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(20);
      }
      throw new Error(`Timed out waiting for ${label}. Last frame:\n${stripAnsi(stdout.lastFrame())}`);
    },
    waitForText: async (text, timeoutMs = 3000) => {
      await harness.waitFor(
        () => stripAnsi(stdout.lastFrame()).includes(text),
        timeoutMs,
        `frame to contain ${JSON.stringify(text)}`,
      );
    },
    unmount,
  };

  // Wait for the first paint so tests start from a rendered tree.
  await harness.waitFor(() => stdout.frames.length > 0, 3000, 'initial render');
  return harness;
}
