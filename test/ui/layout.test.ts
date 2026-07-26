/**
 * Tests for computeOpenCodeLayout — the layout POLICY layer. Since T4, Yoga
 * owns all measurement; this module only decides breakpoints, panel widths
 * and the editor's target height, so the assertions here are strictly about
 * policy (no row arithmetic against component heights).
 */

import { describe, it, expect } from 'vitest';
import { computeOpenCodeLayout, getBreakpoint, truncate, abbreviateModel } from '../../src/ui/layout';

const HEIGHTS = [10, 13, 24, 50];
const WIDTHS = [40, 80, 120];

describe('computeOpenCodeLayout', () => {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      it(`yields a sane editor policy height at ${width}x${height}`, () => {
        const l = computeOpenCodeLayout(width, height);

        // The editor target always exists and leaves room for at least one
        // chat row between the header and status strips.
        expect(l.editorHeight).toBeGreaterThanOrEqual(1);
        expect(l.editorHeight).toBeLessThanOrEqual(15);
        const available = height - l.headerHeight - l.statusBarHeight;
        expect(l.editorHeight).toBeLessThanOrEqual(Math.max(1, available - 2));

        // Strips are single-row policy values.
        expect(l.statusBarHeight).toBe(1);
        expect([0, 1]).toContain(l.headerHeight);
      });
    }
  }

  it('exposes only policy fields — measured heights belong to Yoga', () => {
    const l = computeOpenCodeLayout(80, 24) as Record<string, unknown>;
    // Reverse-engineered component heights must never come back (F5).
    for (const dead of ['contentHeight', 'errorBarHeight', 'operationHeight', 'sessionInfoHeight']) {
      expect(l[dead], `policy layer leaked measured field "${dead}"`).toBeUndefined();
    }
  });

  it('grows the editor with taller terminals up to the cap', () => {
    const short = computeOpenCodeLayout(80, 20);
    const tall = computeOpenCodeLayout(80, 60);
    expect(tall.editorHeight).toBeGreaterThanOrEqual(short.editorHeight);
    expect(tall.editorHeight).toBeLessThanOrEqual(15);
  });

  it('widens the right panel on the wide breakpoint', () => {
    const wide = computeOpenCodeLayout(120, 40);
    const standard = computeOpenCodeLayout(80, 40);
    expect(getBreakpoint(120).name).toBe('wide');
    expect(wide.rightPanelWidth).toBeGreaterThan(standard.rightPanelWidth);
  });

  it('hides the sidebar on narrow terminals', () => {
    const l = computeOpenCodeLayout(40, 24);
    expect(l.sidebarVisible).toBe(false);
    expect(l.rightPanelWidth).toBe(0);
    expect(l.headerVisible).toBe(false);
    expect(l.breakpoint).toBe('tiny');
    expect(l.density).toBe('compact');
  });

  it('reports breakpoint and density for consumers to degrade UI', () => {
    expect(computeOpenCodeLayout(60, 24).breakpoint).toBe('compact');
    expect(computeOpenCodeLayout(80, 24).breakpoint).toBe('standard');
    expect(computeOpenCodeLayout(80, 24).sidebarVisible).toBe(true);
    expect(computeOpenCodeLayout(120, 24).density).toBe('wide');
  });
});

describe('truncate', () => {
  it('returns the text unchanged when it fits', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('hi', 10)).toBe('hi');
  });

  it('clips with an ellipsis when too long', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
    expect(truncate('hello world', 5).length).toBe(5);
  });

  it('handles degenerate widths', () => {
    expect(truncate('anything', 0)).toBe('');
    expect(truncate('anything', -3)).toBe('');
    expect(truncate('anything', 1)).toBe('…');
  });

  it('never exceeds the requested width across breakpoints', () => {
    const line = 'kc v3.2 · anthropic/claude-3-5-sonnet-20241022 · Build';
    for (const width of [40, 60, 80, 120]) {
      const out = truncate(line, width);
      expect(out.length).toBeLessThanOrEqual(width);
      expect(out.includes('\n')).toBe(false);
    }
  });
});

describe('abbreviateModel', () => {
  it('abbreviates Claude model identifiers', () => {
    expect(abbreviateModel('claude-3-5-sonnet-20241022')).toBe('c3.5-sonnet');
    expect(abbreviateModel('claude-3-7-haiku-20250101')).toBe('c3.7-haiku');
  });

  it('strips trailing date stamps from other models', () => {
    expect(abbreviateModel('gpt-4o-20240513')).toBe('gpt-4o');
  });

  it('leaves unknown names without a date stamp unchanged', () => {
    expect(abbreviateModel('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(abbreviateModel('')).toBe('');
  });
});
