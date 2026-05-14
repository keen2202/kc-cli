// Mouse event handling for terminal UI
// Enables mouse click, scroll, and drag support via terminal escape sequences.

export interface MouseEvent {
  x: number;
  y: number;
  button: 'left' | 'right' | 'middle' | 'scroll-up' | 'scroll-down' | 'none';
  action: 'press' | 'release' | 'drag' | 'scroll';
  raw: string;
}

export interface LayoutRegion {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MouseAction =
  | { type: 'sidebar-tab'; tab: string }
  | { type: 'click-message'; index: number }
  | { type: 'focus-input' }
  | { type: 'scroll'; direction: 'up' | 'down'; amount: number }
  | { type: 'resize-panel'; panelId: string; delta: number }
  | null;

/**
 * MouseHandler — enables and parses terminal mouse events.
 *
 * Uses SGR extended mode (\x1b[?1006h) for reliable coordinate parsing.
 */
export class MouseHandler {
  private enabled = false;
  private regions: LayoutRegion[] = [];
  private onAction: ((action: MouseAction) => void) | null = null;

  /**
   * Enable mouse event tracking in the terminal.
   */
  enable(): void {
    if (this.enabled) return;
    // Enable mouse click events
    process.stdout.write('\x1b[?1000h');
    // Enable mouse button events (drag)
    process.stdout.write('\x1b[?1002h');
    // Enable SGR extended mode (reliable coordinates > 223)
    process.stdout.write('\x1b[?1006h');
    this.enabled = true;
  }

  /**
   * Disable mouse event tracking.
   */
  disable(): void {
    if (!this.enabled) return;
    process.stdout.write('\x1b[?1000l');
    process.stdout.write('\x1b[?1002l');
    process.stdout.write('\x1b[?1006l');
    this.enabled = false;
  }

  /**
   * Check if mouse handling is enabled.
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Set layout regions for hit-testing mouse events.
   */
  setRegions(regions: LayoutRegion[]): void {
    this.regions = regions;
  }

  /**
   * Set a callback for mouse actions.
   */
  on(callback: (action: MouseAction) => void): void {
    this.onAction = callback;
  }

  /**
   * Parse a raw terminal data buffer for mouse events.
   * Returns a MouseEvent if the data contains a mouse event, null otherwise.
   */
  parseEvent(data: Buffer): MouseEvent | null {
    const str = data.toString('utf-8');

    // SGR mouse event format: \x1b[<button;col;row;M or m
    // M = press, m = release
    const sgrMatch = str.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (sgrMatch) {
      const buttonCode = parseInt(sgrMatch[1], 10);
      const col = parseInt(sgrMatch[2], 10);
      const row = parseInt(sgrMatch[3], 10);
      const isRelease = sgrMatch[4] === 'm';

      const button = this.decodeButton(buttonCode);
      const action = isRelease ? 'release' : buttonCode >= 64 ? 'scroll' : 'press';

      return {
        x: col - 1, // Terminal coordinates are 1-based
        y: row - 1,
        button,
        action,
        raw: str,
      };
    }

    // Basic mouse event format: \x1b[M<button;col;row
    const basicMatch = str.match(/\x1b\[M(.)(.)(.)/);
    if (basicMatch) {
      const buttonCode = basicMatch[0].charCodeAt(3) - 32;
      const col = basicMatch[0].charCodeAt(4) - 32;
      const row = basicMatch[0].charCodeAt(5) - 32;

      return {
        x: col - 1,
        y: row - 1,
        button: this.decodeButton(buttonCode),
        action: 'press',
        raw: str,
      };
    }

    return null;
  }

  /**
   * Process a mouse event and determine the action based on layout regions.
   */
  processEvent(event: MouseEvent): MouseAction {
    // Scroll events
    if (event.button === 'scroll-up') {
      return { type: 'scroll', direction: 'up', amount: 3 };
    }
    if (event.button === 'scroll-down') {
      return { type: 'scroll', direction: 'down', amount: 3 };
    }

    // Click events — hit-test against layout regions
    if (event.action === 'press' && event.button === 'left') {
      for (const region of this.regions) {
        if (this.hitTest(event.x, event.y, region)) {
          return this.resolveRegionAction(region, event);
        }
      }

      // Default: focus input area (bottom of screen)
      return { type: 'focus-input' };
    }

    return null;
  }

  /**
   * Handle a raw data buffer: parse, process, and invoke callback.
   */
  handleData(data: Buffer): boolean {
    const event = this.parseEvent(data);
    if (!event) return false;

    const action = this.processEvent(event);
    if (action && this.onAction) {
      this.onAction(action);
    }
    return true;
  }

  /**
   * Clean up: disable mouse tracking.
   */
  destroy(): void {
    this.disable();
    this.onAction = null;
    this.regions = [];
  }

  private decodeButton(code: number): MouseEvent['button'] {
    // SGR button codes:
    // 0 = left, 1 = middle, 2 = right
    // 64 = scroll up, 65 = scroll down
    if (code === 0 || code === 32) return 'left';
    if (code === 1 || code === 33) return 'middle';
    if (code === 2 || code === 34) return 'right';
    if (code === 64) return 'scroll-up';
    if (code === 65) return 'scroll-down';
    return 'none';
  }

  private hitTest(x: number, y: number, region: LayoutRegion): boolean {
    return (
      x >= region.x &&
      x < region.x + region.width &&
      y >= region.y &&
      y < region.y + region.height
    );
  }

  private resolveRegionAction(region: LayoutRegion, event: MouseEvent): MouseAction {
    // Sidebar tabs
    if (region.id.startsWith('sidebar-tab-')) {
      const tab = region.id.replace('sidebar-tab-', '');
      return { type: 'sidebar-tab', tab };
    }

    // Message area
    if (region.id === 'messages') {
      const messageIndex = event.y - region.y;
      return { type: 'click-message', index: messageIndex };
    }

    // Input area
    if (region.id === 'input') {
      return { type: 'focus-input' };
    }

    // Panel resize handle
    if (region.id.startsWith('resize-')) {
      return { type: 'resize-panel', panelId: region.id.replace('resize-', ''), delta: 0 };
    }

    return { type: 'focus-input' };
  }
}
