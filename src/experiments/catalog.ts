// Read-only catalog parser for .kc-cli/experiments/catalog.json (kc.experiments.v1).
// Parse failures return an empty catalog — never throw into the main loop.

import { createHash } from 'crypto';
import { z } from 'zod';
import { logger } from '../services/logger';

export const CATALOG_FORMAT = 'kc.experiments.v1';

const variantSchema = z.object({
  variantId: z.string().min(1),
  parentVariantId: z.string().nullable().optional(),
  status: z.enum(['candidate', 'promoted', 'retired', 'rejected']),
  payload: z.union([z.string(), z.record(z.unknown())]),
  evidenceRef: z.string().min(1),
  provenance: z
    .object({
      source: z.string().optional(),
      labRunId: z.string().optional(),
      promotedBy: z.string().optional(),
      promotedAt: z.number().optional(),
      reason: z.string().optional(),
    })
    .optional(),
});

const rolloutSchema = z
  .object({
    mode: z.literal('canary'),
    /** 0–50. 0 means full baseline for every session. */
    percent: z.number().int().min(0).max(50),
  })
  .optional();

const artifactSchema = z.object({
  kind: z.enum(['prompt-surface', 'runtime-policy']),
  baseHash: z.string().min(1),
  active: z.string().nullable().optional(),
  /** P2 canary: serve `active` only to a sessionId-hash bucket. */
  rollout: rolloutSchema,
  variants: z.array(variantSchema).default([]),
});

const catalogSchema = z.object({
  format: z.literal(CATALOG_FORMAT),
  updatedAt: z.number().optional(),
  artifacts: z.record(artifactSchema).default({}),
});

export type CatalogVariant = z.infer<typeof variantSchema>;
export type CatalogArtifact = z.infer<typeof artifactSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

export const EMPTY_CATALOG: Catalog = {
  format: CATALOG_FORMAT,
  updatedAt: 0,
  artifacts: {},
};

/** SHA-256 of a canonical text baseline (used for drift detection). */
export function computeBaseHash(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** SHA-256 of a canonical JSON baseline. */
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

/**
 * Parse catalog JSON text. Invalid / unknown / missing → empty catalog + warn.
 */
export function parseCatalog(raw: string): Catalog {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    logger.services.warn(
      `[experiments] catalog JSON parse failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return EMPTY_CATALOG;
  }

  const result = catalogSchema.safeParse(json);
  if (!result.success) {
    logger.services.warn(
      `[experiments] catalog schema invalid (${result.error.issues.length} issues); using baseline`
    );
    return EMPTY_CATALOG;
  }
  return result.data;
}

/** Active promoted variant for an artifact, if any. */
export function getActivePromotedVariant(
  catalog: Catalog,
  artifactId: string
): CatalogVariant | null {
  const artifact = catalog.artifacts[artifactId];
  if (!artifact?.active) return null;
  const variant = artifact.variants.find(
    v => v.variantId === artifact.active && v.status === 'promoted'
  );
  return variant ?? null;
}

export function artifactIdForPromptSurface(name: string): string {
  return `prompt-surface:${name}`;
}

export const POLICY_ARTIFACT_ID = 'runtime-policy:default';
