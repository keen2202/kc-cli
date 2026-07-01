import chalk from 'chalk';
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

function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
}

export class OverlayManager {
  private stack: Overlay[] = [];

  push(overlay: Overlay): void {
    this.stack = this.stack.filter(o => o.id !== overlay.id);
    this.stack.push(overlay);
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
   * Render all overlays centered with a dimmed backdrop.
   */
  render(width: number, height: number, theme: Theme): string {
    if (this.stack.length === 0) return '';

    const topOverlay = this.stack[this.stack.length - 1]!;
    const result = topOverlay.render(width, height, theme);
    const lines = result.lines;

    if (lines.length === 0) return '';

    // Calculate overlay dimensions
    const overlayHeight = lines.length;
    const overlayWidth = Math.max(1, ...lines.map(l => stripAnsi(l).length));
    const startRow = Math.max(0, Math.floor((height - overlayHeight) / 2) - 1);
    const startCol = Math.max(0, Math.floor((width - overlayWidth) / 2));

    // Build backdrop: dimmed screen using muted color
    const muted = theme ? chalk.hex(theme.colors.muted) : chalk.gray;
    const backdropChar = muted('░');

    // Compose: backdrop + centered overlay
    const output: string[] = [];
    for (let row = 0; row < height; row++) {
      const overlayIdx = row - startRow;
      if (overlayIdx >= 0 && overlayIdx < lines.length) {
        const overlayLine = lines[overlayIdx]!;
        const plainLen = stripAnsi(overlayLine).length;
        const leftPad = ' '.repeat(Math.max(0, startCol + Math.floor((overlayWidth - plainLen) / 2)));
        const rightPad = ' '.repeat(Math.max(0, width - startCol - overlayWidth));
        output.push(backdropChar.repeat(startCol) + leftPad + overlayLine + rightPad + backdropChar.repeat(Math.max(0, width - startCol - leftPad.length - plainLen - rightPad.length)));
      } else {
        output.push(backdropChar.repeat(width));
      }
    }

    return output.join('\n');
  }
}
