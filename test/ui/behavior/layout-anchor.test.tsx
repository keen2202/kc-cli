/**
 * Layout anchor characterization (T0) — renders the real AppRoot at fixed
 * terminal sizes and asserts the USER-VISIBLE layout invariants that all four
 * historical "editor floats up / content overlaps" bugs violated:
 *   1. the frame never exceeds the terminal height,
 *   2. the last non-empty row is the StatusBar,
 *   3. the editor block sits directly above it (bottom-anchored).
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.0.1.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { renderApp, type Harness } from './harness';

let h: Harness | null = null;

afterEach(() => {
  h?.unmount();
  h = null;
});

const SIZES: Array<[number, number]> = [
  [80, 24],
  [120, 40],
  [60, 20],
];

/** Index of the last non-empty line, or -1. */
function lastNonEmptyIndex(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.trim() !== '') return i;
  }
  return -1;
}

describe.each(SIZES)('layout anchor at %ix%i (characterization)', (width, height) => {
  it('status bar is the last row and the editor is anchored directly above it', async () => {
    h = await renderApp({ width, height });
    await h.waitForText('kc>');

    const lines = h.lines();

    // 1. Never taller than the terminal.
    expect(lines.length).toBeLessThanOrEqual(height);

    // 2. Last non-empty row is the StatusBar (mode indicator "○ idle").
    const lastIdx = lastNonEmptyIndex(lines);
    expect(lastIdx).toBeGreaterThanOrEqual(0);
    expect(lines[lastIdx]).toContain('○ idle');

    // 3. The editor block ends immediately above the status bar: the row
    //    right above it is the editor's bottom border, and the editor's
    //    input prompt lives within the block above (no gap of blank rows).
    const above = lines[lastIdx - 1] ?? '';
    expect(above.trimStart().startsWith('└')).toBe(true);

    const promptIdx = lines.findLastIndex((l) => l.includes('kc>'));
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeLessThan(lastIdx);
    // Every row between the prompt and the status bar belongs to the editor
    // block (border rows), i.e. the editor is glued to the bottom.
    for (let i = promptIdx + 1; i < lastIdx; i++) {
      expect(lines[i]!.trim()).not.toBe('');
    }
  });

  it('stays anchored with the error bar visible', async () => {
    const { FakeQueryEngine } = await import('./harness');
    const engine = new FakeQueryEngine();
    engine.scriptEvents([{ type: 'error', error: { message: 'anchor-check' } }]);
    h = await renderApp({ width, height, engine });

    await h.type('x');
    await h.press('\r');
    await h.waitForText('anchor-check');

    const lines = h.lines();
    expect(lines.length).toBeLessThanOrEqual(height);
    const lastIdx = lastNonEmptyIndex(lines);
    expect(lines[lastIdx]).toContain('○ idle');
  });
});

// ── T8 extension: parameterized layout invariant matrix ──
// Spec §3.4.1: sample ≥20 (width, height) combinations across 40–200 × 10–60
// and assert the three user-visible invariants at every size: the frame never
// exceeds the terminal, the status bar owns the last row, and the editor is
// glued directly above it (no floating gap).

const MATRIX: Array<[number, number]> = [
  [40, 10], [40, 24], [40, 60],
  [60, 12], [60, 30], [60, 48],
  [80, 10], [80, 16], [80, 24], [80, 50],
  [100, 14], [100, 30], [100, 60],
  [120, 12], [120, 25], [120, 40],
  [160, 18], [160, 45],
  [200, 10], [200, 34], [200, 60],
];

describe('layout invariant matrix (T8)', () => {
  it.each(MATRIX)('holds the anchor invariants at %ix%i', async (width, height) => {
    h = await renderApp({ width, height });
    await h.waitForText('kc>');

    const lines = h.lines();

    // 1. Never taller than the terminal.
    expect(lines.length).toBeLessThanOrEqual(height);

    // 2. The status bar owns the last non-empty row.
    const lastIdx = lastNonEmptyIndex(lines);
    expect(lastIdx).toBeGreaterThanOrEqual(0);
    expect(lines[lastIdx]).toContain('idle');

    // 3. Editor bottom border sits directly above the status bar and no
    //    blank row separates the prompt from the bottom (editor glued down).
    const above = lines[lastIdx - 1] ?? '';
    expect(above.trimStart().startsWith('└')).toBe(true);

    const promptIdx = lines.findLastIndex((l) => l.includes('kc>'));
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    expect(promptIdx).toBeLessThan(lastIdx);
    for (let i = promptIdx + 1; i < lastIdx; i++) {
      expect(lines[i]!.trim()).not.toBe('');
    }
  });
});
