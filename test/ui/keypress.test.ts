/**
 * Tests for keypress handler module.
 *
 * Covers:
 * - parseKeypress escape sequence parsing
 * - Arrow key detection (up, down, left, right)
 * - Enter/Escape detection
 * - Regular character passthrough
 * - Control character detection
 */

import { describe, it, expect } from 'vitest';
import { parseKeypress, isOverlayKey, type KeypressEvent } from '../../src/ui/keypress';

describe('keypress — parseKeypress', () => {
  it('parses up arrow escape sequence', () => {
    const event = parseKeypress('\x1B[A');
    expect(event.name).toBe('up');
    expect(event.ctrl).toBe(false);
    expect(event.meta).toBe(false);
  });

  it('parses down arrow escape sequence', () => {
    const event = parseKeypress('\x1B[B');
    expect(event.name).toBe('down');
  });

  it('parses left arrow escape sequence', () => {
    const event = parseKeypress('\x1B[C');
    expect(event.name).toBe('left');
  });

  it('parses right arrow escape sequence', () => {
    const event = parseKeypress('\x1B[D');
    expect(event.name).toBe('right');
  });

  it('parses enter key', () => {
    const event = parseKeypress('\r');
    expect(event.name).toBe('return');
  });

  it('parses newline as return', () => {
    const event = parseKeypress('\n');
    expect(event.name).toBe('return');
  });

  it('parses escape key', () => {
    const event = parseKeypress('\x1B');
    expect(event.name).toBe('escape');
  });

  it('parses tab key', () => {
    const event = parseKeypress('\t');
    expect(event.name).toBe('tab');
  });

  it('parses backspace key', () => {
    const event = parseKeypress('\x7F');
    expect(event.name).toBe('backspace');
  });

  it('parses ctrl+c', () => {
    const event = parseKeypress('\x03');
    expect(event.name).toBe('c');
    expect(event.ctrl).toBe(true);
  });

  it('parses ctrl+d', () => {
    const event = parseKeypress('\x04');
    expect(event.name).toBe('d');
    expect(event.ctrl).toBe(true);
  });

  it('parses ctrl+k', () => {
    const event = parseKeypress('\x0B');
    expect(event.name).toBe('k');
    expect(event.ctrl).toBe(true);
  });

  it('parses regular character', () => {
    const event = parseKeypress('a');
    expect(event.name).toBe('a');
    expect(event.ctrl).toBe(false);
    expect(event.meta).toBe(false);
  });

  it('parses regular character "/"', () => {
    const event = parseKeypress('/');
    expect(event.name).toBe('/');
    expect(event.ctrl).toBe(false);
  });

  it('parses regular digit', () => {
    const event = parseKeypress('5');
    expect(event.name).toBe('5');
    expect(event.ctrl).toBe(false);
  });

  it('handles empty string', () => {
    const event = parseKeypress('');
    expect(event.name).toBe('');
  });

  it('handles null input', () => {
    const event = parseKeypress(null as any);
    expect(event.name).toBe('');
  });

  it('handles undefined input', () => {
    const event = parseKeypress(undefined as any);
    expect(event.name).toBe('');
  });
});

describe('keypress — isOverlayKey', () => {
  it('returns true for up arrow', () => {
    expect(isOverlayKey({ name: 'up', ctrl: false, meta: false })).toBe(true);
  });

  it('returns true for down arrow', () => {
    expect(isOverlayKey({ name: 'down', ctrl: false, meta: false })).toBe(true);
  });

  it('returns true for return', () => {
    expect(isOverlayKey({ name: 'return', ctrl: false, meta: false })).toBe(true);
  });

  it('returns true for escape', () => {
    expect(isOverlayKey({ name: 'escape', ctrl: false, meta: false })).toBe(true);
  });

  it('returns false for regular character', () => {
    expect(isOverlayKey({ name: 'a', ctrl: false, meta: false })).toBe(false);
  });

  it('returns false for "/" character', () => {
    expect(isOverlayKey({ name: '/', ctrl: false, meta: false })).toBe(false);
  });

  it('returns false for left arrow', () => {
    expect(isOverlayKey({ name: 'left', ctrl: false, meta: false })).toBe(false);
  });

  it('returns false for right arrow', () => {
    expect(isOverlayKey({ name: 'right', ctrl: false, meta: false })).toBe(false);
  });
});
