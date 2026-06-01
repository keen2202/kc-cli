import type { Overlay, RenderResult } from '../overlay-manager';
import type { KeypressEvent } from '../keypress';
import type { Theme } from '../theme';
import {
  renderModelSelector,
  modelSelectorMoveUp,
  modelSelectorMoveDown,
  modelSelectorGetSelected,
  type ModelSelectorState,
} from '../components/ModelSelector';

export class ModelSelectorOverlay implements Overlay {
  id = 'model-selector';
  zIndex = 10;

  private state: ModelSelectorState;
  private onConfirm: (providerId: string, modelId: string) => void;

  constructor(state: ModelSelectorState, onConfirm: (providerId: string, modelId: string) => void) {
    this.state = state;
    this.onConfirm = onConfirm;
  }

  render(width: number, _height: number, theme: Theme): RenderResult {
    const modelWidth = Math.min(70, width - 4);
    const output = renderModelSelector(this.state, { maxWidth: modelWidth, maxHeight: 16, theme });
    return { lines: output.split('\n') };
  }

  onKeypress(key: KeypressEvent): boolean {
    switch (key.name) {
      case 'up':
        modelSelectorMoveUp(this.state);
        return true;
      case 'down':
        modelSelectorMoveDown(this.state);
        return true;
      case 'return': {
        const selected = modelSelectorGetSelected(this.state);
        if (selected) {
          this.state.active = false;
          this.onConfirm(selected.providerId, selected.modelId);
        }
        return true;
      }
      case 'escape':
        this.state.active = false;
        return true;
      default:
        return false;
    }
  }

  onClose(): void {
    this.state.active = false;
  }
}
