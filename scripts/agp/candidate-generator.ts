/**
 * Candidate generator — intake for manual JSON candidates (primary path) and
 * an optional offline LLM proposer stub (default off, not wired).
 *
 * Offline lab only. Every accepted candidate goes through the same validator
 * in artifact-adapter.ts. Isolation: the generator may only read held-in
 * manifest *metadata* — never held-out task content or evaluation outputs.
 *
 * Layout: scripts/agp/candidates/*.json  (kc.agp.candidate.v1)
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CANDIDATE_FORMAT,
  getAllowlistEntry,
  isAllowlistedArtifact,
  listAllowlistIds,
  validateCandidate,
  type CandidateRecord,
  type CandidateValidationResult,
} from './artifact-adapter';

/** Repo-relative default for manual candidate files. */
export const DEFAULT_CANDIDATES_DIR = path.join('scripts', 'agp', 'candidates');

// ─── Manual candidate intake ────────────────────────────────────────────────

export interface LoadedCandidate {
  sourcePath: string;
  candidate: CandidateRecord;
}

export interface RejectedCandidate {
  sourcePath: string;
  reasons: string[];
}

export interface CandidateIntakeResult {
  accepted: LoadedCandidate[];
  rejected: RejectedCandidate[];
}

/** Candidate files must be plain `*.json` (no lockfiles, no dotfiles). */
export function isValidCandidateFileName(name: string): boolean {
  if (!name.endsWith('.json')) return false;
  if (name.startsWith('.')) return false;
  if (name === 'package.json' || name === 'package-lock.json' || name === 'tsconfig.json') {
    return false;
  }
  return true;
}

/** Validate a raw candidate value (already parsed JSON). */
export function validateCandidateValue(
  raw: unknown,
  sourcePath = '(inline)'
): CandidateValidationResult & { sourcePath: string } {
  const result = validateCandidate(raw);
  return { ...result, sourcePath };
}

/**
 * Load and validate a single candidate file.
 * Missing / unreadable / non-JSON → rejected with a reason (never throws).
 */
export function loadCandidateFromFile(filePath: string): LoadedCandidate | RejectedCandidate {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      sourcePath: filePath,
      reasons: [`read failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      sourcePath: filePath,
      reasons: [`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const result = validateCandidate(json);
  if (!result.ok) {
    return { sourcePath: filePath, reasons: result.reasons };
  }
  return { sourcePath: filePath, candidate: result.candidate };
}

function isRejected(
  value: LoadedCandidate | RejectedCandidate
): value is RejectedCandidate {
  return 'reasons' in value;
}

/**
 * Load every valid `*.json` candidate under `dir`.
 * Invalid files are reported in `rejected`; the function never throws.
 */
export function loadCandidatesFromDir(dir: string): CandidateIntakeResult {
  const accepted: LoadedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { accepted, rejected };
  }

  for (const name of entries.sort()) {
    if (!isValidCandidateFileName(name)) continue;
    const filePath = path.join(dir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const loaded = loadCandidateFromFile(filePath);
    if (isRejected(loaded)) {
      rejected.push(loaded);
    } else {
      accepted.push(loaded);
    }
  }

  return { accepted, rejected };
}

/** Build a well-formed candidate object (for programmatic / test construction). */
export function buildCandidate(input: {
  variantId: string;
  artifactId: string;
  parentVariantId?: string | null;
  payload: string | Record<string, unknown>;
  audit: CandidateRecord['audit'];
  provenance?: CandidateRecord['provenance'];
}): Record<string, unknown> {
  return {
    format: CANDIDATE_FORMAT,
    variantId: input.variantId,
    artifactId: input.artifactId,
    ...(input.parentVariantId !== undefined
      ? { parentVariantId: input.parentVariantId }
      : {}),
    audit: { ...input.audit },
    payload: input.payload,
    ...(input.provenance ? { provenance: { ...input.provenance } } : {}),
  };
}

/**
 * Validate a candidate and (optionally) summarize it for intake logs.
 * Pure — does not touch disk or the overlay store.
 */
export function intakeCandidate(raw: unknown): {
  ok: boolean;
  reasons: string[];
  candidate: CandidateRecord | null;
  allowlistDescription: string | null;
} {
  const result = validateCandidate(raw);
  if (!result.ok) {
    return {
      ok: false,
      reasons: result.reasons,
      candidate: null,
      allowlistDescription: null,
    };
  }
  const entry = getAllowlistEntry(result.candidate.artifactId);
  return {
    ok: true,
    reasons: [],
    candidate: result.candidate,
    allowlistDescription: entry?.description ?? null,
  };
}

/** Snapshot of the frozen allowlist for CLI/status surfaces. */
export function describeAllowlist(): Array<{
  artifactId: string;
  kind: string;
  description: string;
  baseHash: string;
}> {
  return listAllowlistIds().map(id => {
    const entry = getAllowlistEntry(id);
    /* c8 ignore next */
    if (!entry) throw new Error(`allowlist entry missing: ${id}`);
    return {
      artifactId: entry.artifactId,
      kind: entry.kind,
      description: entry.description,
      baseHash: entry.baseHash,
    };
  });
}

// ─── Held-in isolation (spec §3.6 / §4.1) ───────────────────────────────────

/**
 * Metadata-only view of a held-in eval task. The generator must never see
 * prompts, verification commands, or held-out content.
 */
export interface HeldInTaskMetadata {
  taskId: string;
  repo?: string;
  commit?: string;
  maxTurns?: number;
}

/** True when a path is (or points at) a held-out split file. */
export function looksLikeHeldOutPath(p: string): boolean {
  const normalized = p.replace(/\\/g, '/').toLowerCase();
  return normalized.includes('held-out') || normalized.includes('heldout');
}

/**
 * Read held-in task *metadata* from a `kc.experiment_eval.v1` manifest.
 * Refuses any path that looks like a held-out split. Never returns prompt /
 * testCommand / verificationCommand fields.
 */
export function readHeldInMetadata(manifestPath: string): HeldInTaskMetadata[] {
  if (looksLikeHeldOutPath(manifestPath)) {
    throw new Error(
      `candidate generator isolation: refusing held-out path ${manifestPath}`
    );
  }
  const raw = fs.readFileSync(manifestPath, 'utf8');
  const json = JSON.parse(raw) as { tasks?: unknown };
  const tasks = Array.isArray(json.tasks) ? json.tasks : [];
  const out: HeldInTaskMetadata[] = [];
  for (const t of tasks) {
    if (!t || typeof t !== 'object') continue;
    const obj = t as Record<string, unknown>;
    const taskId = typeof obj.taskId === 'string' ? obj.taskId : null;
    if (!taskId) continue;
    out.push({
      taskId,
      ...(typeof obj.repo === 'string' ? { repo: obj.repo } : {}),
      ...(typeof obj.commit === 'string' ? { commit: obj.commit } : {}),
      ...(typeof obj.maxTurns === 'number' ? { maxTurns: obj.maxTurns } : {}),
    });
  }
  return out;
}

// ─── Optional LLM proposer (default off; not wired in v1) ────────────────────

export interface LlmProposerOptions {
  /**
   * Must stay false in the first version. The offline proposer is intentionally
   * not implemented: any attempt to enable it is a hard error so no silent
   * path can produce unvalidated candidates.
   */
  enabled: false;
  /** Budget ceiling for a future proposer (unused). */
  maxProposals?: number;
}

/**
 * Placeholder for an optional offline LLM candidate proposer.
 * Default path is manual JSON only. Enabling this in v1 throws.
 */
export function generateLlmCandidates(
  _options: LlmProposerOptions
): CandidateIntakeResult {
  throw new Error(
    'LLM candidate proposer is not enabled in v1 (spec: manual JSON primary; offline proposer optional and default-off)'
  );
}

export { isAllowlistedArtifact, CANDIDATE_FORMAT };
