/**
 * Tests for the context-aware keybinding resolver (T4).
 *
 * Covers:
 * - Global bindings resolve regardless of context (palette, newSession, ...)
 * - `when`-scoped bindings only resolve while their context is active
 * - The same physical key maps to different commands per context (tab)
 * - Removed bindings (modelSelector/sessionSwitcher, escape→closeOverlay,
 *   escape→cancelMode, toggleThinking, autocomplete) no longer resolve
 */

import { describe, it, expect } from 'vitest';
import { createDefaultKeybindings } from '../../src/ui/keybinding-manager';
import type { KeypressEvent } from '../../src/ui/keypress';

function ev(name: string, mods: Partial<KeypressEvent> = {}): KeypressEvent {
  return { name, ctrl: false, meta: false, ...mods };
}

describe('KeybindingManager — resolve', () => {
  it('resolves global bindings without any context', () => {
    const km = createDefaultKeybindings();
    expect(km.resolve(ev('k', { ctrl: true }))).toBe('palette');
    expect(km.resolve(ev('n', { ctrl: true }))).toBe('newSession');
    expect(km.resolve(ev('l', { ctrl: true }))).toBe('clear');
    expect(km.resolve(ev('t', { ctrl: true }))).toBe('toggleSidebar');
    expect(km.resolve(ev('?'))).toBe('help');
  });

  it('does not resolve when-scoped bindings until the context is active', () => {
    const km = createDefaultKeybindings();
    // filePicker requires the 'input' context.
    expect(km.resolve(ev('f', { ctrl: true }))).toBeNull();
    km.setContext('input');
    expect(km.resolve(ev('f', { ctrl: true }))).toBe('filePicker');
    km.clearContext('input');
    expect(km.resolve(ev('f', { ctrl: true }))).toBeNull();
  });

  it('maps tab to toggleAgentMode only in idle context', () => {
    const km = createDefaultKeybindings();
    km.setContext('idle');
    expect(km.resolve(ev('tab'))).toBe('toggleAgentMode');
    km.clearContext('idle');

    // The autocomplete binding was removed (no real handler existed); tab in
    // input-only context resolves nothing and is swallowed by the editor layer.
    km.setContext('input');
    expect(km.resolve(ev('tab'))).toBeNull();
  });

  it('never binds escape — ESC semantics belong to the focus stack', () => {
    const km = createDefaultKeybindings();
    km.setContext('overlay');
    km.setContext('delete-mode');
    expect(km.resolve(ev('escape'))).toBeNull();
    expect(km.getAll().every((b) => b.key !== 'escape')).toBe(true);
  });

  it('resolves history navigation only in input context', () => {
    const km = createDefaultKeybindings();
    expect(km.resolve(ev('up'))).toBeNull();
    km.setContext('input');
    expect(km.resolve(ev('up'))).toBe('historyPrev');
    expect(km.resolve(ev('down'))).toBe('historyNext');
  });

  it('resolves shift+tab to cycleExecutionMode in every context (T5)', () => {
    const km = createDefaultKeybindings();
    // Global binding: works with no context, in idle, and in input.
    expect(km.resolve(ev('tab', { shift: true }))).toBe('cycleExecutionMode');
    km.setContext('idle');
    expect(km.resolve(ev('tab', { shift: true }))).toBe('cycleExecutionMode');
    // Plain tab in idle still toggles the agent mode — no collision.
    expect(km.resolve(ev('tab'))).toBe('toggleAgentMode');
    // ctrl+g stays as the equivalent fallback chord.
    expect(km.resolve(ev('g', { ctrl: true }))).toBe('cycleExecutionMode');
  });

  it('shift on printable characters never changes resolution', () => {
    const km = createDefaultKeybindings();
    // '?' is typed with shift on most layouts; the resolver must not turn it
    // into 'shift+?' and break the help binding.
    expect(km.resolve(ev('?', { shift: true }))).toBe('help');
  });

  it('no longer advertises the removed modelSelector/sessionSwitcher bindings', () => {
    const km = createDefaultKeybindings();
    // ctrl+o now toggles tool output detail in the chat transcript; ctrl+s
    // (session switcher) stays gone — no backing UI exists (表里如一).
    expect(km.resolve(ev('o', { ctrl: true }))).toBe('toggleToolDetail');
    expect(km.resolve(ev('s', { ctrl: true }))).toBeNull();
    const commands = km.getAll().map((b) => b.command);
    expect(commands).not.toContain('modelSelector');
    expect(commands).not.toContain('sessionSwitcher');
    expect(commands).not.toContain('toggleThinking');
    expect(commands).not.toContain('autocomplete');
    expect(commands).not.toContain('closeOverlay');
    expect(commands).not.toContain('cancelMode');
  });
});
