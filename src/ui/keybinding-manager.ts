/**
 * KeybindingManager - Context-aware keybinding resolution.
 *
 * Maps keypress events to commands based on current context state.
 * Same key can map to different commands depending on context (e.g., overlay open, streaming, idle).
 */

import type { KeypressEvent } from './keypress';

export interface Keybinding {
  key: string;
  command: string;
  when?: string;
  description: string;
}

interface ContextState {
  active: Set<string>;
}

export class KeybindingManager {
  private bindings: Keybinding[] = [];
  private context: ContextState = { active: new Set() };

  register(binding: Keybinding): void {
    this.bindings.push(binding);
  }

  resolve(event: KeypressEvent): string | null {
    const keyStr = formatKeypressEvent(event);

    for (const binding of this.bindings) {
      if (binding.key !== keyStr) continue;
      if (binding.when && !this.context.active.has(binding.when)) continue;
      return binding.command;
    }

    return null;
  }

  setContext(ctx: string): void {
    this.context.active.add(ctx);
  }

  clearContext(ctx: string): void {
    this.context.active.delete(ctx);
  }

  hasContext(ctx: string): boolean {
    return this.context.active.has(ctx);
  }

  getHelpText(): string {
    const lines: string[] = [];
    for (const binding of this.bindings) {
      const ctx = binding.when ? ` (${binding.when})` : '';
      lines.push(`  ${binding.key.padEnd(16)} ${binding.description}${ctx}`);
    }
    return lines.join('\n');
  }

  getAll(): Keybinding[] {
    return [...this.bindings];
  }
}

function formatKeypressEvent(event: KeypressEvent): string {
  const parts: string[] = [];
  if (event.ctrl) parts.push('ctrl');
  if (event.meta) parts.push('meta');
  parts.push(event.name);
  return parts.join('+');
}

/**
 * Create a KeybindingManager with default keybindings registered.
 */
export function createDefaultKeybindings(): KeybindingManager {
  const manager = new KeybindingManager();

  const defaults: Keybinding[] = [
    { key: 'ctrl+k', command: 'palette', description: 'Open command palette' },
    // modelSelector (ctrl+o) / sessionSwitcher (ctrl+s) removed: no backing UI
    // exists, so advertising them would be a broken promise. Enter such flows
    // via the command palette instead once implemented.
    { key: 'ctrl+n', command: 'newSession', description: 'New session' },
    { key: 'ctrl+e', command: 'externalEditor', when: 'input', description: 'Open external editor' },
    { key: 'ctrl+f', command: 'filePicker', when: 'input', description: 'File picker' },
    { key: 'ctrl+r', command: 'deleteAttachment', when: 'input', description: 'Delete attachment mode' },
    { key: 'ctrl+i', command: 'steer', when: 'idle', description: 'Toggle steer mode' },
    { key: 'ctrl+l', command: 'clear', description: 'Clear conversation' },
    { key: 'ctrl+x', command: 'cancel', when: 'streaming', description: 'Cancel current operation' },
    { key: 'ctrl+c', command: 'quit', when: 'idle', description: 'Quit kc-cli' },
    { key: 'ctrl+d', command: 'exit', when: 'idle', description: 'Exit (empty input)' },
    { key: 'ctrl+t', command: 'toggleSidebar', description: 'Toggle sidebar' },
    { key: 'ctrl+shift+t', command: 'toggleThinking', description: 'Toggle thinking chain' },
    { key: 'escape', command: 'closeOverlay', when: 'overlay', description: 'Close overlay' },
    { key: 'escape', command: 'cancelMode', when: 'delete-mode', description: 'Exit delete mode' },
    { key: 'tab', command: 'toggleAgentMode', when: 'idle', description: 'Toggle build/plan mode' },
    { key: 'tab', command: 'autocomplete', when: 'input', description: 'Autocomplete' },
    { key: 'up', command: 'historyPrev', when: 'input', description: 'Previous history' },
    { key: 'down', command: 'historyNext', when: 'input', description: 'Next history' },
    { key: '?', command: 'help', description: 'Show help' },
  ];

  for (const binding of defaults) {
    manager.register(binding);
  }

  return manager;
}
