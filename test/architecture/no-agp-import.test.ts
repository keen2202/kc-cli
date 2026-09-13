/**
 * T13 boundary guard — core must not import the removed AGP subsystem.
 * Offline lab lives in scripts/agp and is allowed; src/** must stay clean.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../src');

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
      acc.push(p);
    }
  }
  return acc;
}

const AGP_IMPORT = /from\s+['"][^'"]*\/agp(?:\/|['"])/;

describe('architecture/no-agp-import', () => {
  it('src/** never imports from src/agp or a path ending in /agp', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (AGP_IMPORT.test(text) || /from\s+['"]\.\.\/agp\//.test(text)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders, `AGP imports found in: ${offenders.join(', ')}`).toEqual([]);
  });

  it('src/agp directory does not exist', () => {
    expect(fs.existsSync(path.join(SRC, 'agp'))).toBe(false);
  });
});
