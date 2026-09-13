/**
 * Immutable evidence store — JSON files keyed by evidenceHash.
 *
 * Offline lab only. Evidence is write-once: a given hash always maps to the
 * same bytes. No raw tool dumps, no secrets; stdout-like fields are truncated
 * to ≤4KB.
 *
 * Layout: <labRoot>/evidence/<evidenceHash-without-prefix>.json
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  EVIDENCE_FORMAT,
  MAX_STDOUT_CHARS,
  canonicalJson,
  computeBaseHash,
  readJsonSafe,
  writeJsonAtomic,
  type LabPaths,
} from './lab-paths';

export interface EvidenceRecord {
  format: typeof EVIDENCE_FORMAT;
  evidenceHash: string;
  kind: string;
  createdAt: number;
  content: Record<string, unknown>;
}

export interface WriteEvidenceInput {
  kind: string;
  content: Record<string, unknown>;
  createdAt?: number;
}

export interface WriteEvidenceResult {
  evidenceHash: string;
  /** true when a new file was created; false when the immutable file already existed. */
  created: boolean;
  path: string;
}

const SECRET_KEY_PATTERN = /(api[_-]?key|secret|password|passwd|token|credential|authorization)/i;
const STDOUT_KEY_PATTERN = /^(stdout|stderr|output|rawOutput|raw_output|toolOutput|combinedOutput)$/i;

/** Truncate to ≤ MAX_STDOUT_CHARS, marking the cut. */
export function truncateStdout(text: string): string {
  if (text.length <= MAX_STDOUT_CHARS) return text;
  return text.slice(0, MAX_STDOUT_CHARS) + '\n…[truncated]';
}

/**
 * Deep-sanitize evidence content:
 * - secret-looking keys → '[redacted]'
 * - stdout-like keys and any over-long string → truncated to ≤4KB
 */
export function sanitizeEvidenceContent(value: unknown, keyHint?: string): unknown {
  if (typeof value === 'string') {
    if (keyHint && SECRET_KEY_PATTERN.test(keyHint)) return '[redacted]';
    if ((keyHint && STDOUT_KEY_PATTERN.test(keyHint)) || value.length > MAX_STDOUT_CHARS) {
      return truncateStdout(value);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitizeEvidenceContent(item, keyHint));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = sanitizeEvidenceContent(v, k);
    }
    return out;
  }
  return value;
}

function hashToFileName(evidenceHash: string): string {
  const bare = evidenceHash.replace(/^sha256:/, '');
  return bare.replace(/[^A-Za-z0-9._-]/g, '_') + '.json';
}

export class EvidenceStore {
  private readonly evidenceDir: string;

  constructor(paths: LabPaths) {
    this.evidenceDir = paths.evidenceDir;
  }

  pathFor(evidenceHash: string): string {
    return path.join(this.evidenceDir, hashToFileName(evidenceHash));
  }

  /**
   * Write immutable evidence. Content is sanitized first; the hash is the
   * SHA-256 of the sanitized canonical JSON. Re-writing the same content is a
   * no-op (created=false). Existing files are never overwritten.
   */
  write(input: WriteEvidenceInput): WriteEvidenceResult {
    const content = sanitizeEvidenceContent(input.content) as Record<string, unknown>;
    // Identity hash covers format+kind+content only — createdAt is metadata
    // and must not create a second immutable file for the same evidence.
    const evidenceHash = computeBaseHash(
      canonicalJson({ format: EVIDENCE_FORMAT, kind: input.kind, content })
    );
    const filePath = this.pathFor(evidenceHash);
    const full: EvidenceRecord = {
      format: EVIDENCE_FORMAT,
      evidenceHash,
      kind: input.kind,
      createdAt: input.createdAt ?? Date.now(),
      content,
    };

    if (fs.existsSync(filePath)) {
      const existing = readJsonSafe<EvidenceRecord>(filePath);
      if (existing.ok && existing.value.evidenceHash === evidenceHash) {
        return { evidenceHash, created: false, path: filePath };
      }
      throw new Error(
        `evidence store: immutable file ${filePath} exists but does not match hash ${evidenceHash}`
      );
    }

    writeJsonAtomic(filePath, full);
    return { evidenceHash, created: true, path: filePath };
  }

  read(evidenceHash: string): EvidenceRecord | null {
    const filePath = this.pathFor(evidenceHash);
    const result = readJsonSafe<EvidenceRecord>(filePath);
    if (!result.ok) return null;
    const value = result.value;
    if (!value || typeof value !== 'object' || value.evidenceHash !== evidenceHash) {
      return null;
    }
    return value;
  }

  exists(evidenceHash: string): boolean {
    return fs.existsSync(this.pathFor(evidenceHash));
  }

  /** All evidence hashes present on disk (sorted). */
  list(): string[] {
    if (!fs.existsSync(this.evidenceDir)) return [];
    const hashes: string[] = [];
    for (const name of fs.readdirSync(this.evidenceDir)) {
      if (!name.endsWith('.json')) continue;
      const bare = name.slice(0, -'.json'.length);
      hashes.push(`sha256:${bare}`);
    }
    return hashes.sort();
  }
}

export function createEvidenceStore(paths: LabPaths): EvidenceStore {
  return new EvidenceStore(paths);
}
