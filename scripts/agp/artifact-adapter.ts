/**
 * Artifact adapter — baseline Prompt surface / policy descriptors, baseHash,
 * overlay schemas, and validators for the frozen allowlist (spec §4.1).
 *
 * Offline lab only. Type-only coupling to src/experiments/protocol.ts.
 * Baseline texts mirror:
 *   - src/api/prompts/instruction-surfaces.ts (BOOTSTRAP_FIRST_TURN_SURFACE,
 *     FAILURE_RECOVERY_SURFACE — join('\n'))
 *   - src/query/QueryEngineRuntimeControl.ts DEFAULT_POLICY allowlist fields
 *     (enabled is frozen and never part of an overlay)
 *
 * Any code-baseline change must update these constants in lockstep so
 * baseHash drift detection stays meaningful.
 */

import { z } from 'zod';
import { computeBaseHash, computeBaseHashJson } from './lab-paths';
import type { ArtifactKind, RuntimePolicyOverlay } from '../../src/experiments/protocol';

export { computeBaseHash, computeBaseHashJson };

// ─── Limits (spec §4.1) ─────────────────────────────────────────────────────

/** Single conditional Prompt surface: ≤2KB. */
export const MAX_PROMPT_SURFACE_CHARS = 2048;
/** Policy redirectInstruction: ≤1KB. */
export const MAX_REDIRECT_INSTRUCTION_CHARS = 1024;
/** Each audit-quad narrative field. */
export const MAX_AUDIT_FIELD_CHARS = 512;
export const MAX_VARIANT_ID_CHARS = 64;

export const CANDIDATE_FORMAT = 'kc.agp.candidate.v1';

// ─── Forbidden patterns (spec §3.9: secrets / command injection / URLs) ─────

export interface ForbiddenPattern {
  name: string;
  pattern: RegExp;
}

/**
 * High-confidence denylist. Prompt surfaces may discuss commands in prose
 * ("do not retry the same command") — only operational / secret / URL shapes
 * are rejected.
 */
export const FORBIDDEN_PROMPT_PATTERNS: readonly ForbiddenPattern[] = [
  { name: 'private-key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----/ },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'github-token', pattern: /\bghp_[A-Za-z0-9]{36}\b/ },
  { name: 'github-fine-grained-token', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/ },
  {
    name: 'secret-assignment',
    pattern: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*\S+/i,
  },
  { name: 'url-instruction', pattern: /\b(?:https?|ftp):\/\/\S+/i },
  { name: 'pipe-to-shell', pattern: /\|\s*(?:ba|z|fi|c)?sh\b/ },
  { name: 'rm-recursive-root', pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(?:\s|$|\*)/ },
  { name: 'command-substitution', pattern: /\$\([^)\n]+\)/ },
  { name: 'sudo-elevate', pattern: /\bsudo\s+(?:rm|chmod|chown|mkfs|dd)\b/ },
];

/** Scan text for forbidden patterns. Returns matched pattern names. */
export function scanForbiddenPatterns(text: string): string[] {
  const hits: string[] = [];
  for (const { name, pattern } of FORBIDDEN_PROMPT_PATTERNS) {
    if (pattern.test(text)) hits.push(name);
  }
  return hits;
}

// ─── Frozen allowlist baselines (spec §4.1) ─────────────────────────────────

/** Mirrors BOOTSTRAP_FIRST_TURN_SURFACE.build() — join('\n'). */
export const BOOTSTRAP_FIRST_TURN_BASELINE = [
  '## First-Turn Orientation',
  'Before acting: restate the goal in one sentence, identify the minimal set of files or commands needed, and check for existing project conventions.',
  'Prefer inspecting the project structure over guessing paths. Do not modify anything until you understand the relevant code.',
].join('\n');

/** Mirrors FAILURE_RECOVERY_SURFACE.build() — join('\n'). */
export const FAILURE_RECOVERY_BASELINE = [
  '## Failure Recovery',
  'The previous tool call failed. Before retrying:',
  '1. Read the error message carefully and identify the terminal cause (missing file, bad arguments, permission, environment).',
  '2. Do NOT repeat the same command with the same arguments — change your approach.',
  '3. If an expected file or artifact is missing, create it directly instead of searching further.',
  '4. If a dependency or toolchain is missing, verify it exists before invoking it again.',
].join('\n');

/**
 * Allowlist-shaped baseline policy (mirrors QueryEngineRuntimeControl
 * DEFAULT_POLICY minus the frozen `enabled` field).
 */
export const RUNTIME_POLICY_BASELINE: RuntimePolicyOverlay = {
  maxSameCallRetries: 2,
  retryIntervention: 'soft',
  maxReadOnlyStreak: 5,
  maxTotalToolMessages: 0,
};

export interface AllowlistEntry {
  artifactId: string;
  kind: ArtifactKind;
  description: string;
  /** Surface name without the `prompt-surface:` prefix (policy entries omit this). */
  surfaceName?: string;
  /** Canonical code baseline (text for surfaces, allowlist object for policy). */
  baseline: string | RuntimePolicyOverlay;
  /** SHA-256 of the canonical baseline; used for drift detection. */
  baseHash: string;
}

function promptEntry(
  surfaceName: string,
  baseline: string,
  description: string
): AllowlistEntry {
  return {
    artifactId: `prompt-surface:${surfaceName}`,
    kind: 'prompt-surface',
    surfaceName,
    description,
    baseline,
    baseHash: computeBaseHash(baseline),
  };
}

function policyEntry(
  baseline: RuntimePolicyOverlay,
  description: string
): AllowlistEntry {
  return {
    artifactId: 'runtime-policy:default',
    kind: 'runtime-policy',
    description,
    baseline,
    baseHash: computeBaseHashJson(baseline),
  };
}

/**
 * First-version allowlist (spec §4.1). Frozen: adding an artifact requires a
 * spec amendment — validators reject everything else.
 */
export const ALLOWLIST: readonly AllowlistEntry[] = [
  promptEntry(
    'bootstrap-first-turn',
    BOOTSTRAP_FIRST_TURN_BASELINE,
    'Conditional bootstrap orientation surface (first turn only).'
  ),
  promptEntry(
    'failure-recovery',
    FAILURE_RECOVERY_BASELINE,
    'Conditional failure-recovery surface (last tool result had an error).'
  ),
  policyEntry(
    RUNTIME_POLICY_BASELINE,
    'Bounded RuntimeControlPolicy overlay (enabled is frozen; numeric fields only).'
  ),
];

const ALLOWLIST_BY_ID = new Map(ALLOWLIST.map(e => [e.artifactId, e]));

export function listAllowlistIds(): string[] {
  return ALLOWLIST.map(e => e.artifactId);
}

export function isAllowlistedArtifact(artifactId: string): boolean {
  return ALLOWLIST_BY_ID.has(artifactId);
}

export function getAllowlistEntry(artifactId: string): AllowlistEntry | null {
  return ALLOWLIST_BY_ID.get(artifactId) ?? null;
}

/** Human-readable baseline descriptor for an allowlisted artifact. */
export function describeBaseline(artifactId: string): {
  artifactId: string;
  kind: ArtifactKind;
  description: string;
  baseHash: string;
  baselinePreview: string;
} | null {
  const entry = ALLOWLIST_BY_ID.get(artifactId);
  if (!entry) return null;
  const preview =
    typeof entry.baseline === 'string'
      ? entry.baseline.slice(0, 200)
      : JSON.stringify(entry.baseline);
  return {
    artifactId: entry.artifactId,
    kind: entry.kind,
    description: entry.description,
    baseHash: entry.baseHash,
    baselinePreview: preview,
  };
}

// ─── Overlay / candidate schemas ────────────────────────────────────────────

/** Policy overlay schema — mirrors src/experiments/runtime.ts policyOverlaySchema. */
export const runtimePolicyOverlaySchema = z
  .object({
    maxSameCallRetries: z.number().int().min(0).max(5).optional(),
    retryIntervention: z.enum(['soft', 'hard']).optional(),
    maxReadOnlyStreak: z.number().int().min(1).max(20).optional(),
    maxTotalToolMessages: z.number().int().min(0).max(200).optional(),
    redirectInstruction: z
      .string()
      .min(1)
      .max(MAX_REDIRECT_INSTRUCTION_CHARS)
      .optional(),
  })
  .strict();

export type RuntimePolicyOverlayPayload = z.infer<typeof runtimePolicyOverlaySchema>;

/** Audit quad — every candidate must carry all four fields (spec §3.5 / T4). */
export const auditQuadSchema = z
  .object({
    targetFailurePattern: z.string().min(1).max(MAX_AUDIT_FIELD_CHARS),
    editedSurface: z.string().min(1).max(MAX_AUDIT_FIELD_CHARS),
    expectedEffect: z.string().min(1).max(MAX_AUDIT_FIELD_CHARS),
    regressionRisk: z.string().min(1).max(MAX_AUDIT_FIELD_CHARS),
  })
  .strict();

export type AuditQuad = z.infer<typeof auditQuadSchema>;

const variantIdSchema = z
  .string()
  .min(1)
  .max(MAX_VARIANT_ID_CHARS)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'variantId must be [A-Za-z0-9._-] starting alnum');

/**
 * Candidate schema. `.strict()` everywhere: any unknown field rejects the
 * whole package (no silent drop).
 */
export const candidateSchema = z
  .object({
    format: z.literal(CANDIDATE_FORMAT),
    variantId: variantIdSchema,
    artifactId: z.string().min(1),
    parentVariantId: z.string().min(1).nullable().optional(),
    audit: auditQuadSchema,
    payload: z.union([
      z.string().min(1).max(MAX_PROMPT_SURFACE_CHARS),
      runtimePolicyOverlaySchema,
    ]),
    provenance: z
      .object({
        source: z.string().min(1).optional(),
        createdAt: z.number().optional(),
        labRunId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CandidateRecord = z.infer<typeof candidateSchema>;

// ─── Validators ─────────────────────────────────────────────────────────────

export type CandidateValidationResult =
  | { ok: true; candidate: CandidateRecord }
  | { ok: false; reasons: string[] };

/**
 * Payload-level checks after schema parse:
 * - artifact must be allowlisted
 * - payload kind must match artifact kind
 * - prompt text must pass forbidden-pattern scan
 * - policy redirectInstruction must pass the same scan
 */
export function validateCandidatePayload(
  artifactId: string,
  payload: string | Record<string, unknown>
): string[] {
  const reasons: string[] = [];
  const entry = getAllowlistEntry(artifactId);
  if (!entry) {
    reasons.push(`unknown artifact (not on allowlist): ${artifactId}`);
    return reasons;
  }

  if (entry.kind === 'prompt-surface') {
    if (typeof payload !== 'string') {
      reasons.push(`payload for ${artifactId} must be a string (prompt text)`);
      return reasons;
    }
    if (payload.trim().length === 0) {
      reasons.push('prompt payload must be non-empty');
    }
    if (payload.length > MAX_PROMPT_SURFACE_CHARS) {
      reasons.push(
        `prompt payload length ${payload.length} exceeds limit ${MAX_PROMPT_SURFACE_CHARS}`
      );
    }
    const hits = scanForbiddenPatterns(payload);
    if (hits.length > 0) {
      reasons.push(`prompt payload hits forbidden patterns: ${hits.join(', ')}`);
    }
    return reasons;
  }

  // runtime-policy
  if (typeof payload === 'string') {
    reasons.push(`payload for ${artifactId} must be an object (policy fields)`);
    return reasons;
  }
  const parsed = runtimePolicyOverlaySchema.safeParse(payload);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.') || '(root)';
      reasons.push(`policy field ${path}: ${issue.message}`);
    }
    return reasons;
  }
  // `enabled` is frozen — schema.strict already rejects it, but assert again
  // for clarity in error output.
  if ('enabled' in payload) {
    reasons.push('policy overlay must not set frozen field: enabled');
  }
  if (parsed.data.redirectInstruction !== undefined) {
    const hits = scanForbiddenPatterns(parsed.data.redirectInstruction);
    if (hits.length > 0) {
      reasons.push(
        `redirectInstruction hits forbidden patterns: ${hits.join(', ')}`
      );
    }
  }
  // At least one field must be present (empty object is a no-op overlay).
  if (Object.keys(parsed.data).length === 0) {
    reasons.push('policy payload must set at least one allowlisted field');
  }
  return reasons;
}

/**
 * Full candidate validation. Unknown top-level / nested fields reject the
 * whole package (zod strict). Payload is then checked against the allowlist.
 */
export function validateCandidate(raw: unknown): CandidateValidationResult {
  const parsed = candidateSchema.safeParse(raw);
  if (!parsed.success) {
    const reasons = parsed.error.issues.map(issue => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    return { ok: false, reasons };
  }

  const payloadReasons = validateCandidatePayload(
    parsed.data.artifactId,
    parsed.data.payload
  );
  if (payloadReasons.length > 0) {
    return { ok: false, reasons: payloadReasons };
  }

  return { ok: true, candidate: parsed.data };
}
