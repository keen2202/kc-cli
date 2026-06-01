/**
 * OverlayManager - Unified overlay system.
 *
 * Manages a stack of overlays with zIndex ordering.
 * Keypress dispatches top-down; first overlay that returns true consumes the event.
 */

import type { KeypressEvent } from './keypress';
import type { Theme } from './theme';

export interface RenderResult {
  lines: string[];
  cursorX?: number;
  cursorY?: number;
  needsInput?: boolean;
}

export interface Overlay {
  id: string;
  zIndex: number;
  render(width: number, height: number, theme: Theme): RenderResult;
  onKeypress(key: KeypressEvent): boolean;
  onClose?(): void;
}

export class OverlayManager {
  private stack: Overlay[] = [];

  push(overlay: Overlay): void {
    // Remove existing overlay with same id
    this.stack = this.stack.filter(o => o.id !== overlay.id);
    this.stack.push(overlay);
    // Sort by zIndex
    this.stack.sort((a, b) => a.zIndex - b.zIndex);
  }

  pop(): Overlay | undefined {
    const overlay = this.stack.pop();
    overlay?.onClose?.();
    return overlay;
  }

  has(id: string): boolean {
    return this.stack.some(o => o.id === id);
  }

  get(id: string): Overlay | undefined {
    return this.stack.find(o => o.id === id);
  }

  remove(id: string): void {
    const idx = this.stack.findIndex(o => o.id === id);
    if (idx >= 0) {
      const overlay = this.stack[idx]!;
      this.stack.splice(idx, 1);
      overlay.onClose?.();
    }
  }

  isEmpty(): boolean {
    return this.stack.length === 0;
  }

  getTop(): Overlay | undefined {
    return this.stack[this.stack.length - 1];
  }

  /**
   * Dispatch keypress top-down. First overlay returning true consumes the event.
   */
  handleKeypress(key: KeypressEvent): boolean {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const overlay = this.stack[i]!;
      if (overlay.onKeypress(key)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Render all overlays in zIndex order, returning the composed output.
   */
  render(width: number, height: number, theme: Theme): string {
    if (this.stack.length === 0) return '';

    const results: string[] = [];
    for (const overlay of this.stack) {
      const result = overlay.render(width, height, theme);
      results.push(result.lines.join('\n'));
    }

    return results.join('\n');
  }
}
