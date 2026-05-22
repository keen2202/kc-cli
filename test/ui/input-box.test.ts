/**
 * Tests for InputBox component.
 *
 * Covers:
 * - renderInputBox with default prompt
 * - renderInputBox with custom prompt
 * - createInputState returns correct defaults
 * - Input rendering with text content
 */

import { describe, it, expect } from 'vitest';
import {
  renderInputBox,
  createInputState,
  type InputState,
} from '../../src/ui/components/InputBox';

describe('InputBox — createInputState', () => {
  it('returns default state with empty text', () => {
    const state = createInputState();
    expect(state.text).toBe('');
    expect(state.cursorPos).toBe(0);
    expect(state.historyIndex).toBe(-1);
  });

  it('returns a fresh state each time', () => {
    const state1 = createInputState();
    const state2 = createInputState();
    expect(state1).not.toBe(state2);
    expect(state1).toEqual(state2);
  });
});

describe('InputBox — renderInputBox', () => {
  it('renders with default kc> prompt', () => {
    const state = createInputState();
    const result = renderInputBox(state);
    expect(result).toContain('kc>');
  });

  it('renders with custom prompt', () => {
    const state = createInputState();
    const result = renderInputBox(state, 'custom>');
    expect(result).toContain('custom>');
  });

  it('renders cursor indicator', () => {
    const state = createInputState();
    const result = renderInputBox(state);
    expect(result).toContain('█');
  });

  it('renders typed text', () => {
    const state: InputState = {
      text: 'hello world',
      cursorPos: 11,
      historyIndex: -1,
    };
    const result = renderInputBox(state);
    expect(result).toContain('hello world');
    expect(result).toContain('kc>');
  });

  it('renders empty input', () => {
    const state = createInputState();
    const result = renderInputBox(state);
    // Should have prompt + cursor
    expect(result).toContain('kc>');
    expect(result).toContain('█');
  });

  it('renders palette prompt', () => {
    const state: InputState = {
      text: 'model',
      cursorPos: 5,
      historyIndex: -1,
    };
    const result = renderInputBox(state, 'palette>');
    expect(result).toContain('palette>');
    expect(result).toContain('model');
  });

  it('renders model selector prompt', () => {
    const state = createInputState();
    const result = renderInputBox(state, 'model>');
    expect(result).toContain('model>');
  });

  it('handles special characters in text', () => {
    const state: InputState = {
      text: 'test with "quotes" and <brackets>',
      cursorPos: 34,
      historyIndex: -1,
    };
    const result = renderInputBox(state);
    expect(result).toContain('"quotes"');
    expect(result).toContain('<brackets>');
  });
});
