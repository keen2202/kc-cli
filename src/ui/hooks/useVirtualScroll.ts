import { useState, useMemo } from 'react';
import { useTerminalSize } from './useTerminalSize';

/**
 * Configuration for the virtual scroll hook.
 *
 * @param totalItems - Total number of items in the list.
 * @param itemHeight - Estimated height (in rows) of each item.
 * @param buffer - Extra items to render above and below the visible window (default 10).
 * @param viewportRows - Override for terminal rows (auto-detected if omitted).
 */
export interface UseVirtualScrollOptions {
  totalItems: number;
  itemHeight?: number;
  buffer?: number;
  viewportRows?: number;
}

/**
 * Result of the virtual scroll hook.
 *
 * @param start - Index of the first item to render.
 * @param end - Index one-past-the-last item to render.
 * @param scrollOffset - Current scroll position (index at top of viewport).
 * @param scrollDown - Scroll the viewport down by one item.
 * @param scrollUp - Scroll the viewport up by one item.
 * @param scrollTo - Scroll to a specific item index.
 * @param pageSize - How many items fit in the visible area.
 * @param isAtEnd - Whether the viewport is at the end of the list.
 * @param isAtStart - Whether the viewport is at the start of the list.
 */
export interface UseVirtualScrollResult {
  start: number;
  end: number;
  scrollOffset: number;
  scrollDown: () => void;
  scrollUp: () => void;
  scrollTo: (index: number) => void;
  pageSize: number;
  isAtEnd: boolean;
  isAtStart: boolean;
}

const DEFAULT_ITEM_HEIGHT = 3;
const DEFAULT_BUFFER = 10;
const HEADER_OVERHEAD = 4; // account for other UI elements in the chat panel

/**
 * A hook that provides windowed / virtual scrolling for terminal-based lists.
 *
 * Uses the terminal size to compute how many items fit on screen, then only
 * renders the visible window plus a configurable buffer above and below to
 * allow smooth scrolling.
 *
 * In a terminal context, "scrolling" means advancing which item appears at
 * the top of the viewport. The total rows available for content is derived
 * from the terminal height minus layout overhead.
 */
export function useVirtualScroll(options: UseVirtualScrollOptions): UseVirtualScrollResult {
  const {
    totalItems,
    itemHeight = DEFAULT_ITEM_HEIGHT,
    buffer = DEFAULT_BUFFER,
    viewportRows: viewportRowsOverride,
  } = options;

  const terminalSize = useTerminalSize();
  const viewportRows = viewportRowsOverride ?? terminalSize.height;

  /** How many items fit in the visible viewport. */
  const pageSize = useMemo(() => {
    const contentRows = Math.max(1, viewportRows - HEADER_OVERHEAD);
    return Math.max(1, Math.ceil(contentRows / itemHeight));
  }, [viewportRows, itemHeight]);

  const [scrollOffset, setScrollOffset] = useState(0);

  /** Ensure the scroll offset is valid when items or page size change. */
  const clampedOffset = useMemo(() => {
    const maxOffset = Math.max(0, totalItems - pageSize);
    return Math.min(maxOffset, Math.max(0, scrollOffset));
  }, [scrollOffset, totalItems, pageSize]);

  const start = useMemo(() => {
    return Math.max(0, clampedOffset - buffer);
  }, [clampedOffset, buffer]);

  const end = useMemo(() => {
    return Math.min(totalItems, clampedOffset + pageSize + buffer);
  }, [clampedOffset, totalItems, pageSize, buffer]);

  const isAtStart = clampedOffset <= 0;
  const maxOffset = Math.max(0, totalItems - pageSize);
  const isAtEnd = clampedOffset >= maxOffset;

  const scrollDown = () => {
    setScrollOffset((prev) => Math.min(maxOffset, prev + 1));
  };

  const scrollUp = () => {
    setScrollOffset((prev) => Math.max(0, prev - 1));
  };

  const scrollTo = (index: number) => {
    setScrollOffset(Math.max(0, Math.min(maxOffset, index)));
  };

  return {
    start,
    end,
    scrollOffset: clampedOffset,
    scrollDown,
    scrollUp,
    scrollTo,
    pageSize,
    isAtEnd,
    isAtStart,
  };
}
