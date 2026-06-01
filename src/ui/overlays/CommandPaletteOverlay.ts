import type { Overlay, RenderResult } from '../overlay-manager';
import type { KeypressEvent } from '../keypress';
import type { Theme } from '../theme';
import {
  renderCommandPalette,
  paletteMoveUp,
  paletteMoveDown,
  paletteGetSelected,
  paletteClose,
  type PaletteState,
  type PaletteCommand,
} from '../components/CommandPalette';

export class CommandPaletteOverlay implements Overlay {
  id = 'command-palette';
  zIndex = 10;

  private state: PaletteState;
  private onSelect: (command: PaletteCommand) => void;

  constructor(state: PaletteState, onSelect: (command: PaletteCommand) => void) {
    this.state = state;
    this.onSelect = onSelect;
  }

  render(width: number, _height: number, theme: Theme): RenderResult {
    const paletteWidth = Math.min(60, width - 4);
    const output = renderCommandPalette(this.state, { maxWidth: paletteWidth, maxHeight: 12, theme });
    return { lines: output.split('\n') };
  }

  onKeypress(key: KeypressEvent): boolean {
    switch (key.name) {
      case 'up':
        paletteMoveUp(this.state);
        return true;
      case 'down':
        paletteMoveDown(this.state);
        return true;
      case 'return': {
        const selected = paletteGetSelected(this.state);
        if (selected) {
          paletteClose(this.state);
          this.onSelect(selected);
        }
        return true;
      }
      case 'escape':
        paletteClose(this.state);
        return true;
      default:
        return false;
    }
  }

  onClose(): void {
    paletteClose(this.state);
  }
}
