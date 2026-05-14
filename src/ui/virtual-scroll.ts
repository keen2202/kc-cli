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
   */
  setItemHeight(index: number, height: number): void {
    this.itemHeights.set(index, height);
  }

  /**
   * Get the visible range of item indices.
   */
  getVisibleRange(): { start: number; end: number } {
    if (this.totalItems === 0) {
      return { start: 0, end: -1 };
    }

    let currentOffset = 0;
    let start = 0;

    // Find the first visible item
    for (let i = 0; i < this.totalItems; i++) {
      const height = this.getItemHeight(i);
      if (currentOffset + height > this.scrollOffset) {
        start = i;
        break;
      }
      currentOffset += height;
    }

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
   */
  getTotalHeight(): number {
    let total = 0;
    for (let i = 0; i < this.totalItems; i++) {
      total += this.getItemHeight(i);
    }
    return total;
  }

  private getItemHeight(index: number): number {
    return this.itemHeights.get(index) ?? this.defaultItemHeight;
  }

  private getOffsetForIndex(index: number): number {
    let offset = 0;
    for (let i = 0; i < index; i++) {
      offset += this.getItemHeight(i);
    }
    return offset;
  }

  private getMaxScrollOffset(): number {
    return Math.max(0, this.getTotalHeight() - this.viewportHeight);
  }
}
