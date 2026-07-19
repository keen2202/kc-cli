/**
 * Tests for computeOpenCodeLayout — verifies the layout never overflows the
 * terminal height and never squeezes the chat content below one row.
 */

import { describe, it, expect } from 'vitest';
import { computeOpenCodeLayout, getBreakpoint } from '../../src/ui/layout';

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
    }
  }

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
