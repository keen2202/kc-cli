/**
 * Schema ↔ handler consistency guard (T3).
 *
 * Every command the keybinding schema can resolve MUST land on a real,
 * non-empty branch of AppRoot's dispatchCommand switch. This is the gate that
 * keeps "advertised in /help but silently dead" bindings (F1: escape→
 * closeOverlay, toggleThinking, autocomplete) from ever coming back.
 *
 * dispatchCommand lives inside the AppOpenCode component so it cannot be
 * imported directly; the test characterizes the source instead, which is
 * exactly what we want to pin — the literal `case` branches that exist.
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.1.3.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDefaultKeybindings } from '../../src/ui/keybinding-manager';

const APP_ROOT_PATH = resolve(__dirname, '../../src/ui/components/AppRoot.tsx');

/** Slice the dispatchCommand switch body out of the AppRoot source. */
function readDispatchCommandBody(): string {
  const source = readFileSync(APP_ROOT_PATH, 'utf8');
  const start = source.indexOf('const dispatchCommand');
  expect(start, 'dispatchCommand not found in AppRoot.tsx').toBeGreaterThan(-1);
  // The useCallback closes with its dependency array: `}, [`.
  const end = source.indexOf('}, [', start);
  expect(end, 'dispatchCommand closing not found').toBeGreaterThan(start);
  return source.slice(start, end);
}

/**
 * Parse `case 'x':` branches into { command → branch body } where fallthrough
 * groups (adjacent cases with no statements between them) share the trailing
 * body, mirroring how the switch actually executes.
 */
function parseCaseBranches(body: string): Map<string, string> {
  const casePattern = /case '([^']+)':/g;
  const matches: Array<{ command: string; index: number; length: number }> = [];
  for (let m = casePattern.exec(body); m; m = casePattern.exec(body)) {
    matches.push({ command: m[1]!, index: m.index, length: m[0]!.length });
  }
  const defaultIdx = body.indexOf('default:');
  const branches = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i]!;
    const next = matches[i + 1];
    const sliceEnd = next ? next.index : defaultIdx !== -1 ? defaultIdx : body.length;
    let text = body.slice(cur.index + cur.length, sliceEnd).trim();
    // Fallthrough: an empty gap means this case shares the next case's body.
    for (let j = i + 1; text === '' && j < matches.length; j++) {
      const jNext = matches[j + 1];
      const jEnd = jNext ? jNext.index : defaultIdx !== -1 ? defaultIdx : body.length;
      text = body.slice(matches[j]!.index + matches[j]!.length, jEnd).trim();
    }
    branches.set(cur.command, text);
  }
  return branches;
}

describe('keybinding schema ↔ dispatchCommand consistency', () => {
  const branches = parseCaseBranches(readDispatchCommandBody());
  const schema = createDefaultKeybindings().getAll();

  it('every schema command has a dispatchCommand case', () => {
    for (const binding of schema) {
      expect(
        branches.has(binding.command),
        `binding "${binding.key}" promises command "${binding.command}" but dispatchCommand has no case for it — a silently dead key`,
      ).toBe(true);
    }
  });

  it('no schema command lands on an empty (swallow-only) branch', () => {
    for (const binding of schema) {
      const body = branches.get(binding.command) ?? '';
      // A branch whose only statement is `return true;` consumes the key
      // without doing anything — a promise with no behavior behind it.
      expect(
        body.replace(/\s+/g, ' '),
        `command "${binding.command}" (key "${binding.key}") has an empty handler branch`,
      ).not.toMatch(/^return true;$/);
    }
  });

  it('the schema never binds escape — ESC belongs to the focus stack', () => {
    for (const binding of schema) {
      expect(
        binding.key.split('+'),
        `binding "${binding.key}"→"${binding.command}" claims escape, which only the FocusStack may interpret`,
      ).not.toContain('escape');
    }
  });

  it('dispatchCommand carries no orphan cases for removed bindings', () => {
    // These commands were retired together with their schema entries; a case
    // reappearing without a binding is dead code creeping back in.
    for (const retired of ['closeOverlay', 'cancelMode', 'autocomplete', 'toggleThinking']) {
      expect(
        branches.has(retired),
        `dispatchCommand still has a case for retired command "${retired}"`,
      ).toBe(false);
    }
  });
});
