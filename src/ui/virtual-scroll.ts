// Virtual scrolling for long conversations
// Only renders visible messages to avoid performance issues with 100+ messages.

export interface RenderableMessage {
  id: string;
  height?: number; // Pre-calculated height if known
  type: 'user' | 'assistant' | 'tool' | 'system';
}

export interface VirtualScrollConfig {
  viewportHeight: number;
  overscan?: number; // Extra items to render above/below viewport
}

export class VirtualScroller {
  private totalItems = 0;
  private viewportHeight: number;
  private overscan: number;
  private scrollOffset = 0;
  private itemHeights = new Map<number, number>();
  private defaultItemHeight = 3; // Default height in terminal lines
  // Prefix sum array for O(1) offset lookups
  private prefixSums: number[] = [0];
  private prefixSumsDirty = true;

  constructor(config: VirtualScrollConfig) {
    this.viewportHeight = config.viewportHeight;
    this.overscan = config.overscan ?? 5;
  }

  /**
   * Update the total number of items.
   */
  setTotalItems(count: number): void {
    this.totalItems = count;
  }

  /**
   * Set the height for a specific item (cached for future calculations).
   * Marks prefix sums as dirty for lazy recomputation.
   */
  setItemHeight(index: number, height: number): void {
    if (this.itemHeights.get(index) !== height) {
      this.itemHeights.set(index, height);
      this.prefixSumsDirty = true;
    }
  }

  /**
   * Get the visible range of item indices.
   * Uses binary search on prefix sums for O(log n) lookup.
   */
  getVisibleRange(): { start: number; end: number } {
    if (this.totalItems === 0) {
      return { start: 0, end: -1 };
    }

    this.rebuildPrefixSumsIfNeeded();

    // Binary search for first visible item
    let start = this.binarySearchOffset(this.scrollOffset);

    // Find the last visible item
    let end = start;
    let visibleHeight = 0;
    for (let i = start; i < this.totalItems; i++) {
      const height = this.getItemHeight(i);
      visibleHeight += height;
      end = i;
      if (visibleHeight >= this.viewportHeight) {
        break;
      }
    }

    // Apply overscan
    const overscanStart = Math.max(0, start - this.overscan);
    const overscanEnd = Math.min(this.totalItems - 1, end + this.overscan);

    return { start: overscanStart, end: overscanEnd };
  }

  /**
   * Render visible items with placeholders for off-screen content.
   * Returns an array of rendered lines.
   */
  render<T>(
    items: T[],
    renderItem: (item: T, index: number) => string[],
    width: number,
  ): string[] {
    this.totalItems = items.length;

    if (items.length === 0) return [];

    const { start, end } = this.getVisibleRange();
    const lines: string[] = [];

    // Top placeholder
    if (start > 0) {
      const hiddenHeight = this.getOffsetForIndex(start);
      lines.push(`\x1b[2m  ↑ ${start} more messages above (${hiddenHeight} lines)\x1b[0m`);
    }

    // Render visible items
    for (let i = start; i <= end && i < items.length; i++) {
      const itemLines = renderItem(items[i], i);
      lines.push(...itemLines);

      // Cache the rendered height
      this.setItemHeight(i, itemLines.length);
    }

    // Bottom placeholder
    if (end < items.length - 1) {
      const remaining = items.length - end - 1;
      lines.push(`\x1b[2m  ↓ ${remaining} more messages below\x1b[0m`);
    }

    return lines;
  }

  /**
   * Scroll up by a number of lines.
   */
  scrollUp(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset - lines);
  }

  /**
   * Scroll down by a number of lines.
   */
  scrollDown(lines: number): void {
    const maxOffset = this.getMaxScrollOffset();
    this.scrollOffset = Math.min(maxOffset, this.scrollOffset + lines);
  }

  /**
   * Scroll to the bottom of the content.
   */
  scrollToBottom(): void {
    this.scrollOffset = this.getMaxScrollOffset();
  }

  /**
   * Scroll to a specific offset.
   */
  scrollTo(offset: number): void {
    this.scrollOffset = Math.max(0, Math.min(this.getMaxScrollOffset(), offset));
  }

  /**
   * Get the current scroll offset.
   */
  getScrollOffset(): number {
    return this.scrollOffset;
  }

  /**
   * Check if scrolled to the bottom.
   */
  isAtBottom(): boolean {
    return this.scrollOffset >= this.getMaxScrollOffset();
  }

  /**
   * Get the total content height.
   * Uses prefix sum array for O(1) lookup.
   */
  getTotalHeight(): number {
    this.rebuildPrefixSumsIfNeeded();
    return this.prefixSums[this.totalItems] ?? 0;
  }

  private getItemHeight(index: number): number {
    return this.itemHeights.get(index) ?? this.defaultItemHeight;
  }

  /**
   * Get offset for a given index using prefix sum array (O(1)).
   */
  private getOffsetForIndex(index: number): number {
    this.rebuildPrefixSumsIfNeeded();
    return this.prefixSums[index] ?? 0;
  }

  private getMaxScrollOffset(): number {
    return Math.max(0, this.getTotalHeight() - this.viewportHeight);
  }

  /**
   * Rebuild prefix sums if heights have changed.
   */
  private rebuildPrefixSumsIfNeeded(): void {
    if (!this.prefixSumsDirty) return;

    this.prefixSums = new Array(this.totalItems + 1);
    this.prefixSums[0] = 0;
    for (let i = 0; i < this.totalItems; i++) {
      this.prefixSums[i + 1] = this.prefixSums[i] + this.getItemHeight(i);
    }
    this.prefixSumsDirty = false;
  }

  /**
   * Binary search for the item index at a given scroll offset.
   * Returns the index of the first item whose cumulative offset exceeds the target.
   */
  private binarySearchOffset(targetOffset: number): number {
    let lo = 0;
    let hi = this.totalItems - 1;

    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.prefixSums[mid + 1] <= targetOffset) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    return lo;
  }
}
