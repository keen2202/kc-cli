// Memory extraction guard (T1) — deterministic output validation + secret redaction
//
// This module is the safety layer that sits BETWEEN a (non-deterministic) LLM
// extraction call and persistence. It is intentionally:
//   - PURE / SIDE-EFFECT FREE: no I/O, no network, no mutable module state.
//   - DETERMINISTIC: given the same `raw` + options it always returns the same
//     result (timestamps/filenames are derived from an injectable `now`).
//
// Guardrails implemented here (see spec §5):
//   GR1 output schema validation (zod) — illegal entries are DISCARDED, never thrown.
//   GR2 secret redaction — hard secrets (keys/tokens/passwords) reject the entry;
//       protected paths are placeholder-redacted.
//   GR3 quality + size caps — min length, code-only filter, per-entry byte cap,
//       and a max-entries-per-run cap.

import { z } from 'zod';
import type { MemoryEntry, MemoryType } from '../memory/types';
import { containsProtectedPath } from '../permissions/protectedPaths';
import { logger } from './logger';

// ── Quality / size thresholds (shared with the heuristic tier) ──────────────
export const MIN_CONTENT_LENGTH = 20;
export const CODE_BLOCK_RATIO_THRESHOLD = 0.5;
/** Per-entry content byte cap. Content above this is truncated (GR3). */
export const MAX_CONTENT_BYTES = 2048;
/** Default max number of validated entries returned per run (GR3). */
export const DEFAULT_MAX_ENTRIES = 50;
/** Placeholder used when a protected path is redacted (GR2). */
export const PATH_PLACEHOLDER = '[redacted-path]';

/**
 * zod schema for a single memory frontmatter header (GR1).
 * `type` must be one of the four discrete memory types.
 */
const MemoryHeaderSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(500),
  type: z.enum(['user', 'feedback', 'project', 'reference']),
});

/**
 * Secret VALUE patterns (hard reject). Aligned with the `KC_*` secret naming
 * convention in `RunTool/secrets.ts`. Patterns intentionally use NO global flag
 * so `.test()` stays stateless (keeps this module deterministic / pure).
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, // PEM private key blocks
  /\bsk-[A-Za-z0-9_-]{16,}\b/, // OpenAI / Anthropic style keys (sk- / sk-ant-)
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bgh[posur]_[A-Za-z0-9]{20,}\b/, // GitHub tokens (ghp_/gho_/ghs_/ghu_/ghr_)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/, // GitHub fine-grained PAT
  /\bAIza[0-9A-Za-z_-]{20,}\b/, // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/, // JWT
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/i, // Bearer token
  // key/secret/token/password assignments (`key: value` or `key=value`)
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  /\bKC_[A-Z0-9_]+\s*[:=]\s*\S+/, // KC_* env-style assignment
];

export interface RedactionResult {
  /** Content after path redaction (unchanged when a hard secret was found). */
  content: string;
  /** True when a hard secret was detected — caller MUST discard the entry. */
  hadSecret: boolean;
  /** True when at least one protected path was placeholder-redacted. */
  redactedPath: boolean;
}

/**
 * Redact secrets from memory content (GR2).
 * - Hard secrets (keys/tokens/passwords/PEM) → `hadSecret=true`; caller rejects.
 * - Protected paths → replaced token-wise with {@link PATH_PLACEHOLDER}.
 * Pure & deterministic.
 */
export function redactSecrets(content: string): RedactionResult {
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(content)) {
      return { content, hadSecret: true, redactedPath: false };
    }
  }

  let redactedPath = false;
  const redacted = content.replace(/\S+/g, (token) => {
    if (containsProtectedPath(token)) {
      redactedPath = true;
      return PATH_PLACEHOLDER;
    }
    return token;
  });

  return { content: redacted, hadSecret: false, redactedPath };
}

/**
 * Quality gate shared by the heuristic tier and the LLM guard (GR3).
 * Rejects too-short content and content that is mostly code blocks.
 */
export function passesQualityCheck(content: string): { pass: boolean; reason?: string } {
  const trimmed = content.trim();

  if (trimmed.length < MIN_CONTENT_LENGTH) {
    return { pass: false, reason: 'too_short' };
  }

  const codeBlockMatches = trimmed.match(/```[\s\S]*?```/g) || [];
  const codeBlockLength = codeBlockMatches.reduce((sum, block) => sum + block.length, 0);
  if (trimmed.length > 0 && codeBlockLength / trimmed.length > CODE_BLOCK_RATIO_THRESHOLD) {
    return { pass: false, reason: 'code_only' };
  }

  return { pass: true };
}

export interface ParseOptions {
  /** Cap on the number of validated entries returned (default 50). */
  maxEntries?: number;
  /** Per-entry content byte cap (default 2048). */
  maxContentBytes?: number;
  /** Confidence applied to every validated entry (default 'high'). */
  defaultConfidence?: 'low' | 'high';
  /** Injectable clock for deterministic timestamps/filenames. */
  now?: number;
}

/**
 * Aggregate counters describing what happened during a parse run. Fed into
 * memory telemetry (T7) so operators can observe extraction health without
 * inspecting individual entries.
 */
export interface ParseStats {
  /** Total frontmatter blocks discovered in the raw output. */
  totalBlocks: number;
  /** Entries that passed all guardrails and were returned. */
  accepted: number;
  /** Entries discarded because the frontmatter failed schema validation. */
  discardedInvalid: number;
  /** Entries discarded because content was empty or low quality. */
  discardedQuality: number;
  /** Entries discarded because a hard secret was detected (GR2). */
  discardedSecret: number;
  /** Entries whose content had at least one protected path redacted. */
  redactedPaths: number;
  /** Entries whose content was truncated to the byte cap. */
  truncated: number;
}

export interface ParseResult {
  entries: MemoryEntry[];
  stats: ParseStats;
}

/**
 * Parse and validate raw LLM extraction output into MemoryEntry[] (GR1–GR3).
 *
 * Robust to the fenced/unfenced frontmatter block format emitted by
 * {@link buildExtractionPrompt}. Illegal blocks (missing fields / unknown type /
 * bad frontmatter / secret-bearing / low quality) are silently DISCARDED with a
 * debug log — this function NEVER throws.
 */
export function parseAndValidate(raw: string, options: ParseOptions = {}): MemoryEntry[] {
  return parseAndValidateWithStats(raw, options).entries;
}

/**
 * Same as {@link parseAndValidate} but also returns {@link ParseStats} so the
 * caller can feed extraction telemetry (redacted secrets, discards, etc.).
 */
export function parseAndValidateWithStats(raw: string, options: ParseOptions = {}): ParseResult {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxContentBytes ?? MAX_CONTENT_BYTES;
  const confidence = options.defaultConfidence ?? 'high';
  const now = options.now ?? Date.now();

  const results: MemoryEntry[] = [];
  const stats: ParseStats = {
    totalBlocks: 0,
    accepted: 0,
    discardedInvalid: 0,
    discardedQuality: 0,
    discardedSecret: 0,
    redactedPaths: 0,
    truncated: 0,
  };
  if (!raw || typeof raw !== 'string') return { entries: results, stats };

  const blocks = extractFrontmatterBlocks(raw);
  stats.totalBlocks = blocks.length;
  let index = 0;

  for (const block of blocks) {
    if (results.length >= maxEntries) break;

    const headerObj = parseYamlHeader(block.yaml);
    // Normalize type casing before strict enum validation.
    if (typeof headerObj.type === 'string') {
      headerObj.type = headerObj.type.toLowerCase();
    }

    const parsed = MemoryHeaderSchema.safeParse(headerObj);
    if (!parsed.success) {
      stats.discardedInvalid++;
      logger.memory.debug('[MemoryGuard] Discarded entry with invalid frontmatter', {
        keys: Object.keys(headerObj),
      });
      continue;
    }

    let content = block.content.trim();
    if (!content) {
      stats.discardedQuality++;
      logger.memory.debug('[MemoryGuard] Discarded entry with empty content');
      continue;
    }

    const quality = passesQualityCheck(content);
    if (!quality.pass) {
      stats.discardedQuality++;
      logger.memory.debug('[MemoryGuard] Discarded low-quality entry', { reason: quality.reason });
      continue;
    }

    const redaction = redactSecrets(content);
    if (redaction.hadSecret) {
      stats.discardedSecret++;
      logger.memory.debug('[MemoryGuard] Discarded entry containing a secret');
      continue;
    }
    if (redaction.redactedPath) stats.redactedPaths++;
    content = redaction.content;

    if (Buffer.byteLength(content, 'utf-8') > maxBytes) {
      content = truncateToBytes(content, maxBytes);
      stats.truncated++;
    }

    const baseName = sanitizeBaseName(parsed.data.name);
    results.push({
      header: {
        name: parsed.data.name,
        description: parsed.data.description,
        type: parsed.data.type as MemoryType,
        createdAt: now,
        updatedAt: now,
        confidence,
      },
      content,
      filePath: '',
      fileName: `${baseName}_${now}_${index}.md`,
      mtime: now,
    });
    index++;
  }

  stats.accepted = results.length;
  return { entries: results, stats };
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Remove standalone code-fence lines (```` ``` ```` / ```` ```lang ````). */
function stripCodeFences(raw: string): string {
  return raw.replace(/^[ \t]*```[^\n]*$/gm, '');
}

const FENCE = '---';

/**
 * Split raw text into `{ yaml, content }` frontmatter blocks.
 * A block is `--- <yaml> --- <content>` where content runs until the next fence
 * (which opens the next block) or end of input.
 */
function extractFrontmatterBlocks(raw: string): Array<{ yaml: string; content: string }> {
  const lines = stripCodeFences(raw).split(/\r?\n/);
  const blocks: Array<{ yaml: string; content: string }> = [];
  const isFence = (l: string): boolean => l.trim() === FENCE;

  let i = 0;
  while (i < lines.length) {
    if (!isFence(lines[i])) {
      i++;
      continue;
    }

    i++; // consume opening fence
    const yamlLines: string[] = [];
    while (i < lines.length && !isFence(lines[i])) {
      yamlLines.push(lines[i]);
      i++;
    }
    if (i >= lines.length) break; // no closing fence → malformed tail, stop
    i++; // consume closing fence

    const contentLines: string[] = [];
    while (i < lines.length && !isFence(lines[i])) {
      contentLines.push(lines[i]);
      i++;
    }

    blocks.push({ yaml: yamlLines.join('\n'), content: contentLines.join('\n').trim() });
  }

  return blocks;
}

const YAML_LINE = /^([A-Za-z_][\w-]*):\s*(.*)$/;

/** Parse simple `key: value` frontmatter lines into a plain record. */
function parseYamlHeader(yaml: string): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const match = line.match(YAML_LINE);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    obj[match[1]] = value;
  }
  return obj;
}

/** Truncate a string so its UTF-8 byte length does not exceed `maxBytes`. */
function truncateToBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, 'utf-8') <= maxBytes) return str;
  let lo = 0;
  let hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(str.slice(0, mid), 'utf-8') <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return str.slice(0, lo);
}

/** Derive a filesystem-safe base filename from a memory name. */
function sanitizeBaseName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'memory';
}
