import type { Overlay, RenderResult } from '../overlay-manager';
import type { KeypressEvent } from '../keypress';
import type { Theme } from '../theme';
import { renderHelpPanel } from '../components/HelpPanel';
import type { Keybinding } from '../keybinding-manager';

export class HelpPanelOverlay implements Overlay {
  id = 'help-panel';
  zIndex = 15;

  private commands: Array<{ name: string; description: string }>;
  private keybindings: Keybinding[];

  constructor(commands: Array<{ name: string; description: string }>, keybindings: Keybinding[]) {
    this.commands = commands;
    this.keybindings = keybindings;
  }

  render(_width: number, _height: number, theme: Theme): RenderResult {
    const output = renderHelpPanel({
      commands: this.commands,
      keybindings: this.keybindings,
      theme,
    });
    return { lines: output.split('\n') };
  }

  onKeypress(key: KeypressEvent): boolean {
    switch (key.name) {
      case 'escape':
        return true;
      default:
        return false;
    }
  }
}
