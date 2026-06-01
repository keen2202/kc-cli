import type { Overlay, RenderResult } from '../overlay-manager';
import type { KeypressEvent } from '../keypress';
import type { Theme } from '../theme';
import { renderMultiFileDiff, type FileDiff } from '../diff-viewer';

export class DiffPreviewOverlay implements Overlay {
  id = 'diff-preview';
  zIndex = 5;

  private diffs: FileDiff[];
  private activeIndex: number;
  private maxWidth: number;
  private onAccept: (index: number) => void;
  private onReject: (index: number) => void;

  constructor(
    diffs: FileDiff[],
    activeIndex: number,
    maxWidth: number,
    onAccept: (index: number) => void,
    onReject: (index: number) => void,
  ) {
    this.diffs = diffs;
    this.activeIndex = activeIndex;
    this.maxWidth = maxWidth;
    this.onAccept = onAccept;
    this.onReject = onReject;
  }

  render(_width: number, _height: number, theme: Theme): RenderResult {
    const output = renderMultiFileDiff(this.diffs, this.activeIndex, {
      maxWidth: this.maxWidth,
      theme,
    });
    return { lines: output.split('\n') };
  }

  onKeypress(key: KeypressEvent): boolean {
    switch (key.name) {
      case 'left':
        this.activeIndex = (this.activeIndex - 1 + this.diffs.length) % this.diffs.length;
        return true;
      case 'right':
        this.activeIndex = (this.activeIndex + 1) % this.diffs.length;
        return true;
      case 'a':
        this.onAccept(this.activeIndex);
        return true;
      case 'r':
        this.onReject(this.activeIndex);
        return true;
      case 'escape':
        return true;
      default:
        return false;
    }
  }
}
