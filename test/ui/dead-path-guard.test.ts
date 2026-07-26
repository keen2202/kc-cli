/**
 * Dead-path import guard (T7).
 *
 * Statically scans every module under src/ui and asserts that no live code
 * imports from retired or restricted legacy modules. This is the structural
 * gate (F10) that keeps dead string-rendering paths from re-entangling with
 * the live ink tree after the T6/T7 cleanup:
 *
 *  - RETIRED modules were deleted outright (Sidebar.ts, ChatView.ts); any
 *    import specifier that still resolves to them is a regression.
 *  - RESTRICTED modules still exist because they host live runtime helpers,
 *    but only the explicitly exempted importers may touch them, and data
 *    contracts must always come from view-protocol instead.
 *
 * The deny-list and the exemption list are maintained HERE, in one place,
 * so any change to the dead-path surface is a reviewed test diff.
 *
 * Spec: docs/specs/ui-structural-hardening-spec.md §3.3.2.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const SRC_UI = resolve(__dirname, '../../src/ui');

/** Modules deleted in T7 — importing them anywhere in src/ui is forbidden. */
const RETIRED_MODULES = ['Sidebar', 'ChatView'];

/**
 * Legacy modules that survive T7 only because they carry live helpers.
 * Key: module basename. Value: importers (src/ui-relative, posix separators)
 * that are allowed to import it — everyone else must go via view-protocol.
 */
const RESTRICTED_MODULES: Record<string, string[]> = {
  // renderThinkingChain / renderToolCallCard are live render helpers used by
  // the chat transcript. Contracts (ThinkingChain, ToolCallData) live in
  // view-protocol and must be imported from there.
  ThinkingChainView: ['components/ChatMessagesView.tsx'],
  ToolCallCard: ['components/ChatMessagesView.tsx'],
  // Legacy string-rendering status bar kept for unit tests only; the live
  // status bar is StatusBarView.tsx.
  StatusBar: [],
};

/** Zombie identifiers removed in T7 — must never reappear under src/ui. */
const ZOMBIE_IDENTIFIERS = [
  'sidebarMoveUp',
  'sidebarMoveDown',
  'sidebarMoveLeft',
  'sidebarMoveRight',
  'createSidebarSelection',
  'renderSidebar',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Extract every import/re-export specifier from a module's source. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const pattern = /(?:import|export)[^'";]*?from\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

/** Does a relative specifier resolve to the given module basename? */
function targetsModule(spec: string, moduleName: string): boolean {
  if (!spec.startsWith('.')) return false; // package imports are fine
  const normalized = spec.replace(/\.(js|ts|tsx)$/, '');
  return normalized === moduleName || normalized.endsWith(`/${moduleName}`);
}

const files = walk(SRC_UI);
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')] as const));
const rel = (f: string) => relative(SRC_UI, f).replace(/\\/g, '/');

describe('dead-path import guard (T7)', () => {
  it('scans a plausible src/ui module set', () => {
    // Sanity: the walker actually found the live tree (guard must not pass
    // vacuously because of a broken path).
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => rel(f) === 'view-protocol.ts')).toBe(true);
  });

  it('no module imports from retired (deleted) modules', () => {
    const violations: string[] = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        for (const dead of RETIRED_MODULES) {
          if (targetsModule(spec, dead)) {
            violations.push(`${rel(file)} imports '${spec}' (retired: ${dead})`);
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('restricted legacy modules are only imported by exempted files', () => {
    const violations: string[] = [];
    for (const [file, source] of sources) {
      for (const spec of importSpecifiers(source)) {
        for (const [mod, allowed] of Object.entries(RESTRICTED_MODULES)) {
          if (targetsModule(spec, mod) && !allowed.includes(rel(file))) {
            violations.push(`${rel(file)} imports '${spec}' (restricted: ${mod})`);
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('zombie identifiers never reappear under src/ui', () => {
    const violations: string[] = [];
    for (const [file, source] of sources) {
      for (const zombie of ZOMBIE_IDENTIFIERS) {
        if (source.includes(zombie) && rel(file) !== 'view-protocol.ts') {
          violations.push(`${rel(file)} mentions '${zombie}'`);
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });

  it('data contracts are imported from view-protocol, not legacy components', () => {
    // The contract names must never be re-imported from a components/* module;
    // view-protocol is their single home.
    const contractNames = [
      'SidebarData',
      'ChatMessage',
      'ThinkingChain',
      'ToolCallData',
      'classifyThinkingSteps',
      'createSidebarData',
    ];
    const violations: string[] = [];
    const importPattern = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+['"]([^'"]+)['"]/g;
    for (const [file, source] of sources) {
      let m: RegExpExecArray | null;
      while ((m = importPattern.exec(source)) !== null) {
        const [, names, spec] = m;
        if (!spec.startsWith('.') || spec.includes('view-protocol')) continue;
        if (!/components\//.test(spec) && !spec.startsWith('./')) continue;
        for (const contract of contractNames) {
          const imported = names.split(',').map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]);
          if (imported.includes(contract)) {
            violations.push(`${rel(file)} imports contract '${contract}' from '${spec}'`);
          }
        }
      }
    }
    expect(violations, violations.join('\n')).toEqual([]);
  });
});
