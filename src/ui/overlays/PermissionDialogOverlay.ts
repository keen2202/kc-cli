import type { Overlay, RenderResult } from '../overlay-manager';
import type { KeypressEvent } from '../keypress';
import type { Theme } from '../theme';
import { renderPermissionDialog, resolvePermissionKey, type PermissionDecision } from '../components/PermissionDialog';

export class PermissionDialogOverlay implements Overlay {
  id = 'permission-dialog';
  zIndex = 20;

  private toolName: string;
  private inputSummary?: string;
  private onDecision: (decision: PermissionDecision) => void;

  constructor(toolName: string, inputSummary: string | undefined, onDecision: (decision: PermissionDecision) => void) {
    this.toolName = toolName;
    this.inputSummary = inputSummary;
    this.onDecision = onDecision;
  }

  render(_width: number, _height: number, theme: Theme): RenderResult {
    const output = renderPermissionDialog({
      toolName: this.toolName,
      inputSummary: this.inputSummary,
      theme,
    });
    return { lines: output.split('\n') };
  }

  onKeypress(key: KeypressEvent): boolean {
    if (key.ctrl || key.meta) return false;

    const decision = resolvePermissionKey(key.name);
    if (decision) {
      this.onDecision(decision);
      return true;
    }

    return false;
  }
}
