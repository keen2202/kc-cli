/**
 * Tests for the context-aware keybinding resolver (T4).
 *
 * Covers:
 * - Global bindings resolve regardless of context (palette, newSession, ...)
 * - `when`-scoped bindings only resolve while their context is active
 * - The same physical key maps to different commands per context (tab, escape)
 * - Removed bindings (modelSelector/sessionSwitcher) no longer resolve
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

  it('maps tab to different commands depending on context', () => {
    const km = createDefaultKeybindings();
    km.setContext('idle');
    expect(km.resolve(ev('tab'))).toBe('toggleAgentMode');
    km.clearContext('idle');

    km.setContext('input');
    expect(km.resolve(ev('tab'))).toBe('autocomplete');
  });

  it('maps escape to close overlay vs exit delete-mode by context', () => {
    const km = createDefaultKeybindings();
    km.setContext('overlay');
    expect(km.resolve(ev('escape'))).toBe('closeOverlay');
    km.clearContext('overlay');

    km.setContext('delete-mode');
    expect(km.resolve(ev('escape'))).toBe('cancelMode');
  });

  it('resolves history navigation only in input context', () => {
    const km = createDefaultKeybindings();
    expect(km.resolve(ev('up'))).toBeNull();
    km.setContext('input');
    expect(km.resolve(ev('up'))).toBe('historyPrev');
    expect(km.resolve(ev('down'))).toBe('historyNext');
  });

  it('no longer advertises the removed modelSelector/sessionSwitcher bindings', () => {
    const km = createDefaultKeybindings();
    // ctrl+o and ctrl+s previously mapped to model selector / session switcher;
    // those UIs do not exist, so the bindings must be gone (表里如一).
    expect(km.resolve(ev('o', { ctrl: true }))).toBeNull();
    expect(km.resolve(ev('s', { ctrl: true }))).toBeNull();
    const commands = km.getAll().map((b) => b.command);
    expect(commands).not.toContain('modelSelector');
    expect(commands).not.toContain('sessionSwitcher');
  });
});
