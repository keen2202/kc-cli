/**
 * FocusStack — the single input arbiter for the terminal UI.
 *
 * Exactly one layer (the top of the stack) owns the keyboard at any moment.
 * ESC has one meaning everywhere: "ask the top layer to leave". Layers push
 * themselves when they appear (overlay opened, permission pending, …) and
 * unregister when they leave; keys never reach a layer that is not on top,
 * so keystrokes can never leak into the editor while a dialog is up.
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.1.1 (T1).
 */

import type { KeypressEvent } from './keypress';

export type FocusLayerId =
  | 'editor'
  | 'error'
  | 'goal'
  | 'permission'
  | 'diff-detail'
  | 'palette'
  | 'file-picker'
  | 'exit-confirm';

export interface FocusLayer {
  id: FocusLayerId;
  /** Returns true when the key was consumed by this layer (stop here either way — keys never fall through to lower layers). */
  onKey: (event: KeypressEvent) => boolean;
  /**
   * Unified ESC semantics: invoked when the user asks this layer to leave
   * (close / cancel / deny). Return false when the layer does not respond to
   * ESC (e.g. the editor base layer); the key is NOT forwarded downward.
   */
  onEscape: () => boolean;
  /**
   * Safety net invoked exactly once when the layer is removed from the stack
   * (voluntary unregister or host component unmount). Promise-style layers
   * (permission) use this to guarantee their pending decision always
   * resolves, so the executor can never deadlock.
   */
  onDispose?: () => void;
}

/**
 * ESC belongs to the FocusStack, not the keybinding schema: its one meaning
 * everywhere is "ask the top layer to leave". /help appends this line so the
 * advertised promise matches the arbiter's actual semantics (dead
 * escape→closeOverlay schema bindings were the F1 failure).
 */
export const ESCAPE_HELP_LINE = `  ${'escape'.padEnd(16)} Close the current overlay / cancel the current action`;

type FocusListener = () => void;

export class FocusStack {
  private layers: FocusLayer[] = [];
  private listeners = new Set<FocusListener>();

  /**
   * Push a layer on top of the stack. Returns an idempotent unregister
   * function that removes the layer (wherever it sits) and fires its
   * `onDispose` exactly once.
   *
   * push/unregister are fully synchronous — they complete within the tick of
   * the event handler that triggered them, so `top()` is never stale when the
   * next key arrives (no useEffect lag, F3-class races are structurally gone).
   */
  push(layer: FocusLayer): () => void {
    this.layers.push(layer);
    this.notify();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const idx = this.layers.indexOf(layer);
      if (idx !== -1) this.layers.splice(idx, 1);
      try {
        layer.onDispose?.();
      } finally {
        this.notify();
      }
    };
  }

  /**
   * Route one normalized keypress. Only the top layer may consume input:
   * - ESC → top layer's `onEscape()`; a false return means "not handled",
   *   but the key still stops here (never forwarded to layers below).
   * - anything else → top layer's `onKey()`.
   * Returns whether the key was handled.
   */
  handleKey(event: KeypressEvent): boolean {
    const top = this.layers[this.layers.length - 1];
    if (!top) return false;
    if (event.name === 'escape' && !event.ctrl && !event.meta) {
      return top.onEscape();
    }
    return top.onKey(event);
  }

  /** Id of the layer currently owning the keyboard, or null when empty. */
  top(): FocusLayerId | null {
    return this.layers[this.layers.length - 1]?.id ?? null;
  }

  /** Bottom-to-top ids, for tests and status-bar diagnostics. */
  snapshot(): FocusLayerId[] {
    return this.layers.map((layer) => layer.id);
  }

  /** Notifies on every push/unregister; used to derive keybinding context synchronously. */
  subscribe(listener: FocusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
