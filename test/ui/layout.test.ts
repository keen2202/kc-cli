/**
 * Tests for computeOpenCodeLayout — verifies the layout never overflows the
 * terminal height and never squeezes the chat content below one row.
 */

import { describe, it, expect } from 'vitest';
import { computeOpenCodeLayout, getBreakpoint, truncate, abbreviateModel } from '../../src/ui/layout';

const HEIGHTS = [10, 13, 24, 50];
const WIDTHS = [40, 80, 120];

describe('computeOpenCodeLayout', () => {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      it(`fits within ${width}x${height} without overflow`, () => {
        const l = computeOpenCodeLayout(width, height);

        // Content is never squeezed away.
        expect(l.contentHeight).toBeGreaterThanOrEqual(1);

        // The full column (header + content-row + status) fits the terminal.
        const total =
          l.headerHeight +
          l.contentHeight +
          l.editorHeight +
          l.errorBarHeight +
          l.statusBarHeight;
        expect(total).toBeLessThanOrEqual(height);

        // The right column (sessionInfo) never exceeds the main content row.
        const rowHeight = l.contentHeight + l.editorHeight + l.errorBarHeight;
        expect(l.sessionInfoHeight).toBeLessThanOrEqual(rowHeight);
      });

      it(`reserves error-bar space within ${width}x${height}`, () => {
        const l = computeOpenCodeLayout(width, height, { errorVisible: true });
        expect(l.errorBarHeight).toBeGreaterThan(0);
        expect(l.contentHeight).toBeGreaterThanOrEqual(1);
        const total =
          l.headerHeight +
          l.contentHeight +
          l.editorHeight +
          l.errorBarHeight +
          l.statusBarHeight;
        expect(total).toBeLessThanOrEqual(height);
      });

      it(`reserves operation-summary space within ${width}x${height}`, () => {
        const l = computeOpenCodeLayout(width, height, { operationVisible: true });
        expect(l.operationHeight).toBeGreaterThan(0);
        expect(l.contentHeight).toBeGreaterThanOrEqual(1);
        const total =
          l.headerHeight +
          l.contentHeight +
          l.editorHeight +
          l.errorBarHeight +
          l.operationHeight +
          l.statusBarHeight;
        expect(total).toBeLessThanOrEqual(height);
      });
    }
  }

  it('reserves no operation-summary space when hidden', () => {
    expect(computeOpenCodeLayout(80, 24).operationHeight).toBe(0);
    expect(computeOpenCodeLayout(80, 24, { operationVisible: false }).operationHeight).toBe(0);
  });

  it('degrades the operation-summary height on compact breakpoints', () => {
    const compact = computeOpenCodeLayout(40, 24, { operationVisible: true });
    const standard = computeOpenCodeLayout(80, 24, { operationVisible: true });
    expect(getBreakpoint(40).density).toBe('compact');
    expect(compact.operationHeight).toBeLessThan(standard.operationHeight);
  });

  it('anchors the editor to the bottom (no wasted rows) when sidebar is visible', () => {
    // At 80 cols the sidebar is visible; sessionInfo must NOT shrink the left
    // column, so header + content-row + status fills the whole terminal.
    const l = computeOpenCodeLayout(80, 24);
    expect(l.sidebarVisible).toBe(true);
    const total =
      l.headerHeight + l.contentHeight + l.editorHeight + l.errorBarHeight + l.statusBarHeight;
    expect(total).toBe(24);
  });

  it('widens the right panel on the wide breakpoint', () => {
    const wide = computeOpenCodeLayout(120, 40);
    const standard = computeOpenCodeLayout(80, 40);
    expect(getBreakpoint(120).name).toBe('wide');
    expect(wide.rightPanelWidth).toBeGreaterThan(standard.rightPanelWidth);
  });

  it('hides the sidebar and session info on narrow terminals', () => {
    const l = computeOpenCodeLayout(40, 24);
    expect(l.sidebarVisible).toBe(false);
    expect(l.rightPanelWidth).toBe(0);
    expect(l.sessionInfoHeight).toBe(0);
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
