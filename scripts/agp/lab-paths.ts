/**
 * Lab filesystem helpers for scripts/agp.
 *
 * Offline lab only — never imported by src/**.
 * All JSON writes go through temp + rename so a crash cannot leave a
 * half-written catalog / lineage / overlay file in place of the previous one.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';

/** Canonical runtime catalog format (mirrors src/experiments/catalog.ts; type-only coupling). */
export const CATALOG_FORMAT = 'kc.experiments.v1';

export const VERSIONS_FORMAT = 'kc.agp.versions.v1';
export const OVERLAYS_FORMAT = 'kc.agp.overlays.v1';
export const EVIDENCE_FORMAT = 'kc.agp.evidence.v1';

/** Hard cap on any stdout-like string stored in evidence. */
export const MAX_STDOUT_CHARS = 4096;

export interface LabPaths {
  /** Lab root. Default: <cwd>/.kc-cli/experiments */
  root: string;
  catalogPath: string;
  labDir: string;
  versionsPath: string;
  overlaysPath: string;
  evidenceDir: string;
}

export function resolveLabPaths(root?: string, cwd?: string): LabPaths {
  const base = path.resolve(
    cwd ?? process.cwd(),
    root ?? path.join('.kc-cli', 'experiments')
  );
  return {
    root: base,
    catalogPath: path.join(base, 'catalog.json'),
    labDir: path.join(base, 'lab'),
    versionsPath: path.join(base, 'lab', 'versions.json'),
    overlaysPath: path.join(base, 'lab', 'overlays.json'),
    evidenceDir: path.join(base, 'evidence'),
  };
}

/** SHA-256 of canonical UTF-8 text. Matches computeBaseHash in src/experiments/catalog.ts. */
export function computeBaseHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** SHA-256 of canonical JSON (sorted keys, stable). */
export function computeBaseHashJson(value: unknown): string {
  return computeBaseHash(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortDeep(obj[key]);
    }
    return out;
  }
  return value;
}

export interface WriteJsonAtomicOptions {
  /** Injectable rename for crash-safety tests (ESM cannot spy fs.renameSync). */
  rename?: (src: string, dest: string) => void;
}

/**
 * Atomic JSON write: write to a sibling temp file, then rename.
 * If rename fails (or the process dies before rename), the destination is
 * left untouched — either missing or still the previous content.
 */
export function writeJsonAtomic(
  filePath: string,
  data: unknown,
  options?: WriteJsonAtomicOptions
): void {
  const rename = options?.rename ?? ((src: string, dest: string) => fs.renameSync(src, dest));
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  const body = JSON.stringify(data, null, 2) + '\n';
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    rename(tmp, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

export type ReadJsonResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'missing' | 'corrupt'; message: string };

/** Read a JSON file. Missing and corrupt are distinct so writers can refuse to clobber. */
export function readJsonSafe<T = unknown>(filePath: string): ReadJsonResult<T> {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'missing', message: `missing: ${filePath}` };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { ok: true, value: JSON.parse(raw) as T };
  } catch (err) {
    return {
      ok: false,
      reason: 'corrupt',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** True when the file exists but is not valid JSON (or not an object). */
export function isCorruptJsonFile(filePath: string): boolean {
  const result = readJsonSafe(filePath);
  if (result.ok) {
    return result.value === null || typeof result.value !== 'object';
  }
  return result.reason === 'corrupt';
}
