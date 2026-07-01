import { parseKeypress } from '../keypress';
import {
  createInputState,
  insertChar,
  deleteBefore,
  deleteAfter,
  insertNewline,
  moveCursorLeft,
  moveCursorRight,
  moveCursorUp,
  moveCursorDown,
  moveToLineStart,
  moveToLineEnd,
  deleteWordBefore,
  deleteToLineStart,
  deleteToLineEnd,
  getLineCount,
  type InputState,
} from './InputBox';
import type { OverlayManager } from '../overlay-manager';
import type { KeybindingManager } from '../keybinding-manager';
import type { Theme } from '../theme';

export interface InputDelegates {
  onUserInput: (input: string) => Promise<void>;
  onCommand: (command: string) => void;
  onRenderRequest: () => void;
  onClearScreen: () => void;
  onOverlayKeypress: (event: ReturnType<typeof parseKeypress>) => boolean;
  onKeybindingCommand: (command: string) => void;
  isRunning: () => boolean;
  getOverlayManager: () => OverlayManager;
  getKeybindingManager: () => KeybindingManager;
  getTheme: () => Theme;
}

export class InputManager {
  private delegates: InputDelegates;
  private rawModeActive: boolean = false;
  private processingRawInput: boolean = false;
  private inputState: InputState;
  private history: string[] = [];
  private historyIndex: number = -1;
  private savedLine: string = '';

  constructor(delegates: InputDelegates) {
    this.delegates = delegates;
    this.inputState = createInputState();
  }

  getInputState(): InputState {
    return this.inputState;
  }

  getHistory(): readonly string[] {
    return this.history;
  }

  /** Display the prompt and wait for input via raw mode. */
  prompt(): void {
    if (!this.delegates.isRunning()) return;

    if (!this.rawModeActive) {
      this.enableRawMode();
    }

    this.delegates.onRenderRequest();
  }

  /** Submit the current input as a command or user message. */
  private submit(): void {
    const trimmed = this.inputState.text.trim();

    if (trimmed.startsWith('/')) {
      this.delegates.onCommand(trimmed);
    } else if (trimmed) {
      // Add to history
      if (this.history.length === 0 || this.history[this.history.length - 1] !== this.inputState.text) {
        this.history.push(this.inputState.text);
      }
      this.delegates.onUserInput(trimmed);
    }

    this.inputState = createInputState();
    this.historyIndex = -1;
    this.savedLine = '';
  }

  /** Enable raw mode on stdin and set up the keypress listener. */
  private enableRawMode(): void {
    if (this.rawModeActive) return;

    this.rawModeActive = true;
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', this._onRawKeypress);
  }

  /** Disable raw mode and detach listeners. */
  private disableRawMode(): void {
    if (!this.rawModeActive) return;

    process.stdin.removeListener('data', this._onRawKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    this.rawModeActive = false;
  }

  enableRawInput(): void {
    this.enableRawMode();
  }

  restoreReadline(): void {
    // No-op: raw mode is now persistent; we just re-render
    this.delegates.onRenderRequest();
  }

  isRawModeActive(): boolean {
    return this.rawModeActive;
  }

  close(): void {
    this.disableRawMode();
  }

  private _onRawKeypress = (chunk: string): void => {
    if (this.processingRawInput) return;
    this.processingRawInput = true;

    try {
      const event = parseKeypress(chunk);

      // Route 1: Overlay consumes first
      if (this.delegates.onOverlayKeypress(event)) {
        this.processingRawInput = false;
        return;
      }

      // Route 2: Keybinding manager
      const keybindingManager = this.delegates.getKeybindingManager();
      const command = keybindingManager.resolve(event);
      if (command) {
        this.delegates.onKeybindingCommand(command);
        // If a keybinding handled it, don't process as text input
        // unless the command is explicitly for text manipulation
        if (!isTextNavigationCommand(command)) {
          this.processingRawInput = false;
          return;
        }
      }

      // Route 3: Text input handling
      this.handleTextInput(event);
    } finally {
      this.processingRawInput = false;
    }
  };

  private handleTextInput(event: ReturnType<typeof parseKeypress>): void {
    const { name, ctrl, shift, isPrintable } = event;

    // Ctrl+C: exit
    if (ctrl && name === 'c') {
      process.exit(0);
      return;
    }

    // Enter (no shift): submit
    if (name === 'return' && !shift) {
      this.submit();
      this.delegates.onRenderRequest();
      return;
    }

    // Shift+Enter: insert newline
    if (name === 'return' && shift) {
      this.inputState = insertNewline(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Tab: handled by keybinding autocomplete
    if (name === 'tab' && !shift) {
      this.delegates.onRenderRequest();
      return;
    }

    // Escape: clear input if overlays are active, otherwise no-op
    if (name === 'escape') {
      if (!this.delegates.getOverlayManager().isEmpty()) {
        this.inputState = createInputState();
        this.delegates.onRenderRequest();
      }
      return;
    }

    // Backspace
    if (name === 'backspace') {
      this.inputState = deleteBefore(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Delete
    if (name === 'delete') {
      this.inputState = deleteAfter(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Left arrow
    if (name === 'left') {
      this.inputState = moveCursorLeft(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Right arrow
    if (name === 'right') {
      this.inputState = moveCursorRight(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Up arrow: history navigation or cursor up
    if (name === 'up') {
      const lineCount = getLineCount(this.inputState);
      const isFirstLine = lineCount <= 1 || this.inputState.cursorPos <= this.inputState.text.indexOf('\n');
      if (isFirstLine && this.history.length > 0) {
        // History navigation
        if (this.historyIndex === -1) {
          this.savedLine = this.inputState.text;
        }
        const newIndex = Math.min(this.history.length - 1, this.historyIndex + 1);
        this.historyIndex = newIndex;
        const histEntry = this.history[this.history.length - 1 - newIndex];
        this.inputState = {
          ...this.inputState,
          text: histEntry,
          cursorPos: histEntry.length,
        };
      } else {
        const termWidth = process.stdout.columns || 80;
        this.inputState = moveCursorUp(this.inputState, termWidth);
      }
      this.delegates.onRenderRequest();
      return;
    }

    // Down arrow: history navigation or cursor down
    if (name === 'down') {
      const lineCount = getLineCount(this.inputState);
      const lastNewline = this.inputState.text.lastIndexOf('\n');
      const isLastLine = lastNewline === -1 || this.inputState.cursorPos > lastNewline;
      if (isLastLine && this.historyIndex >= 0) {
        const newIndex = this.historyIndex - 1;
        this.historyIndex = newIndex;
        if (newIndex === -1) {
          this.inputState = {
            ...this.inputState,
            text: this.savedLine,
            cursorPos: this.savedLine.length,
          };
        } else {
          const histEntry = this.history[this.history.length - 1 - newIndex];
          this.inputState = {
            ...this.inputState,
            text: histEntry,
            cursorPos: histEntry.length,
          };
        }
      } else {
        const termWidth = process.stdout.columns || 80;
        this.inputState = moveCursorDown(this.inputState, termWidth);
      }
      this.delegates.onRenderRequest();
      return;
    }

    // Ctrl+A: move to line start
    if (ctrl && name === 'a') {
      this.inputState = moveToLineStart(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Ctrl+E: move to line end
    if (ctrl && name === 'e') {
      this.inputState = moveToLineEnd(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Ctrl+U: delete to line start
    if (ctrl && name === 'u') {
      this.inputState = deleteToLineStart(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Ctrl+K: delete to line end
    if (ctrl && name === 'k') {
      this.inputState = deleteToLineEnd(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Ctrl+W: delete word before
    if (ctrl && name === 'w') {
      this.inputState = deleteWordBefore(this.inputState);
      this.delegates.onRenderRequest();
      return;
    }

    // Regular printable characters — includes IME-composed CJK text, emoji,
    // and any non-control Unicode. Accept multi-codepoint strings from IMEs.
    if (!ctrl && event.isPrintable && name.length > 0) {
      this.inputState = insertChar(this.inputState, name);
      this.delegates.onRenderRequest();
      return;
    }
  }
}

/** Commands that should still fall through to text input handling after keybinding dispatch. */
function isTextNavigationCommand(command: string): boolean {
  return command === 'autocomplete';
}
