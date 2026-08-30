/**
 * Frame-transport flicker guard (behavior): the composer must stay visually
 * still unless its own content changed.
 *
 * Root cause this pins down: ink 7 ships two frame transports. The default
 * ("standard") log-update erases and rewrites the ENTIRE previous frame on
 * every render; kc-cli runs streaming flushes at ~30fps plus per-second clock
 * ticks, so the composer (white cursor cell, border) was repainted dozens of
 * times per turn — the visible flicker. The production renderer therefore
 * opts into `incrementalRendering`, which diffs line by line and skips lines
 * whose content is unchanged (guarded here), leaving only changed chat/status
 * rows rewritten.
 *
 * These tests exercise the REAL write path (`debug: false`), so every recorded
 * chunk is an actual transport diff, not a full debug frame. CI detection is
 * neutralized because ink switches to one-shot non-diffed writes under CI.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.hoisted(() => {
  // ink decides between the diffing "interactive" renderer and one-shot
  // non-diffed writes from is-in-ci, evaluated at module load. The transport
  // behavior under test only exists on the interactive path, so neutralize CI
  // detection BEFORE the module graph (ink) is imported below.
  for (const key of ['CI', 'CONTINUOUS_INTEGRATION']) delete process.env[key];
});

import { renderApp, FakeQueryEngine, KEYS, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

// Full-line erases use CSI 2K; a per-line incremental rewrite uses CSI K
// (erase-to-end). A run of 2K therefore identifies a multi-line erase —
// i.e. the standard transport's whole-frame wipe (frameHeight-1 ≈ 28 of them).
const FULL_LINE_ERASE = '\u001b[2K';
// The composer prompt is the first composer row; it appears in a transport
// chunk exactly when that row is being (re)written.
const PROMPT = 'kc>';

function stripAnsi(s: string): string {
  return s.replace(
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    '',
  );
}

/** All raw chunks written after `fromIndex`. */
function chunksFrom(fromIndex: number): string[] {
  return h!.rawFrames().slice(fromIndex);
}

/** Content ever written after `fromIndex` (erased rows included — fine for
 *  "has the app rendered X at all" checks on the diff transport). */
function accumulatedText(fromIndex: number): string {
  return stripAnsi(chunksFrom(fromIndex).join(''));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Max number of full-line erases within any single chunk. */
function maxEraseRun(chunks: string[]): number {
  return chunks.reduce((max, chunk) => Math.max(max, countOccurrences(chunk, FULL_LINE_ERASE)), 0);
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 14 text deltas paced at 70ms ≈ 1s of streaming → ≥10 coalesced flushes. */
function pacedStreamScript(): Array<{ type: string; text: string; delayBeforeMs?: number }> {
  return [
    { type: 'text_delta', text: 'stream starts ' },
    ...Array.from({ length: 14 }, (_, i) => ({
      type: 'text_delta',
      text: `chunk${i} `,
      delayBeforeMs: 70,
    })),
  ];
}

describe('composer frame transport (flicker guard, behavior)', () => {
  it('streaming flushes and clock ticks never repaint the composer rows', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents(pacedStreamScript());
    engine.holdNextTurn();
    h = await renderApp({
      width: 100,
      height: 30,
      engine,
      renderOptions: { debug: false, incrementalRendering: true },
    });

    await h.type('hello');
    await h.press(KEYS.enter);
    await h.waitFor(
      () => accumulatedText(0).includes('stream starts'),
      5000,
      'streaming to start',
    );
    // Let the turn-start burst settle (composer clearing, status-bar switch).
    await delay(300);
    const streamingStart = h.rawFrames().length;

    // Cross ≥10 flush windows AND a ≥1s status-bar/chat clock tick.
    await delay(1400);

    const after = chunksFrom(streamingStart);
    // Sanity: the transport actually painted during the window (flushes and
    // ticks happened) — otherwise the assertions below pass vacuously.
    expect(after.length).toBeGreaterThanOrEqual(5);
    expect(accumulatedText(streamingStart)).toContain('chunk13');

    // The composer's prompt row must not be rewritten while streaming…
    const promptRewrites = after.filter((chunk) => chunk.includes(PROMPT)).length;
    expect(promptRewrites).toBeLessThanOrEqual(2);
    // …and no chunk may wipe a block of full lines (the whole-frame erase that
    // reads as flicker; incremental mode only ever erases-to-end per line).
    expect(maxEraseRun(after)).toBeLessThan(8);

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
  });

  it('keystrokes repaint only the changed composer rows, not the frame', async () => {
    h = await renderApp({
      width: 100,
      height: 30,
      renderOptions: { debug: false, incrementalRendering: true },
    });
    // Let the initial paint and measurement settles land.
    await delay(400);
    const before = h.rawFrames().length;

    await h.type('abc');
    // ink throttles paints to maxFps (≈33ms); let the final keystroke commit
    // land before asserting on the recorded transport stream.
    await delay(200);

    const after = chunksFrom(before);
    // Every keystroke committed (the composer rows themselves DO change).
    expect(accumulatedText(before)).toContain('abc');
    expect(after.length).toBeGreaterThanOrEqual(3);
    // But no keystroke may erase+rewrite the whole frame.
    expect(maxEraseRun(after)).toBeLessThan(8);
  });

  it('the legacy standard transport repaints the composer every flush (contrast, documents the fix)', async () => {
    const engine = new FakeQueryEngine();
    engine.scriptEvents(pacedStreamScript());
    engine.holdNextTurn();
    h = await renderApp({
      width: 100,
      height: 30,
      engine,
      renderOptions: { debug: false, incrementalRendering: false },
    });

    await h.type('hello');
    await h.press(KEYS.enter);
    await h.waitFor(
      () => accumulatedText(0).includes('stream starts'),
      5000,
      'streaming to start',
    );
    await delay(300);
    const streamingStart = h.rawFrames().length;
    await delay(1200);

    const after = chunksFrom(streamingStart);
    expect(after.length).toBeGreaterThanOrEqual(5);
    // Standard transport: every flush erases the previous frame and rewrites
    // it whole — the composer row rides along on every single flush chunk.
    const promptRewrites = after.filter((chunk) => chunk.includes(PROMPT)).length;
    expect(promptRewrites).toBeGreaterThanOrEqual(5);
    expect(maxEraseRun(after)).toBeGreaterThanOrEqual(15);

    engine.releaseGate();
    await h.waitFor(() => engine.completedTurns === 1, 5000, 'turn to complete');
  });
});
