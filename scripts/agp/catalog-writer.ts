/**
 * Catalog writer — builds and atomically updates .kc-cli/experiments/catalog.json
 * (kc.experiments.v1) from the lab overlay store.
 *
 * Offline lab only. Type-only coupling to src/experiments/{protocol,catalog}.ts.
 * Every write is temp + rename. A corrupt existing catalog is never overwritten.
 */

import {
  CATALOG_FORMAT,
  computeBaseHash,
  readJsonSafe,
  writeJsonAtomic,
  type LabPaths,
  type WriteJsonAtomicOptions,
} from './lab-paths';
import type { Catalog, CatalogArtifact, CatalogVariant } from '../../src/experiments/catalog';
import type { OverlayStore, OverlayStatus } from './overlay-store';

export type LoadCatalogState =
  | { state: 'missing'; catalog: Catalog }
  | { state: 'valid'; catalog: Catalog }
  | { state: 'corrupt'; message: string };

function emptyCatalog(): Catalog {
  return { format: CATALOG_FORMAT, updatedAt: 0, artifacts: {} };
}

/** Minimal structural validation matching src/experiments/catalog.ts contract. */
export function isCatalogShape(value: unknown): value is Catalog {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.format !== CATALOG_FORMAT) return false;
  if (!obj.artifacts || typeof obj.artifacts !== 'object') return false;
  for (const artifact of Object.values(obj.artifacts as Record<string, unknown>)) {
    if (!artifact || typeof artifact !== 'object') return false;
    const a = artifact as Record<string, unknown>;
    if (typeof a.kind !== 'string') return false;
    if (typeof a.baseHash !== 'string') return false;
    if (!Array.isArray(a.variants)) return false;
  }
  return true;
}

/**
 * Load catalog. Missing and corrupt are distinguished so writers can refuse
 * to clobber a corrupt file (runtime falls back to baseline; lab must not
 * silently replace evidence of corruption).
 */
export function loadCatalog(catalogPath: string): LoadCatalogState {
  const result = readJsonSafe(catalogPath);
  if (!result.ok) {
    if (result.reason === 'missing') {
      return { state: 'missing', catalog: emptyCatalog() };
    }
    return { state: 'corrupt', message: result.message };
  }
  if (!isCatalogShape(result.value)) {
    return { state: 'corrupt', message: 'catalog shape invalid (format/artifacts)' };
  }
  return { state: 'valid', catalog: result.value };
}

export type UpdateCatalogResult =
  | { ok: true; catalog: Catalog }
  | { ok: false; reason: 'corrupt' | 'io'; message: string };

/**
 * Read-modify-write catalog. Refuses to touch the file when the existing
 * catalog is corrupt. Atomic temp + rename on success.
 */
export function updateCatalog(
  catalogPath: string,
  mutate: (current: Catalog) => Catalog,
  writeOptions?: WriteJsonAtomicOptions
): UpdateCatalogResult {
  const loaded = loadCatalog(catalogPath);
  if (loaded.state === 'corrupt') {
    return {
      ok: false,
      reason: 'corrupt',
      message: `refusing to overwrite corrupt catalog: ${loaded.message}`,
    };
  }

  const next = mutate(structuredClone(loaded.catalog));
  next.format = CATALOG_FORMAT;
  next.updatedAt = Date.now();

  try {
    writeJsonAtomic(catalogPath, next, writeOptions);
    return { ok: true, catalog: next };
  } catch (err) {
    return {
      ok: false,
      reason: 'io',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Rebuild the full catalog from overlay-store state.
 * Only variants with a non-empty evidenceRef are exported; runtime only
 * honors promoted + active, but the catalog keeps the full lab history.
 */
export function buildCatalogFromOverlays(overlays: OverlayStore, now?: number): Catalog {
  const catalog = emptyCatalog();
  catalog.updatedAt = now ?? Date.now();

  for (const artifactId of overlays.listArtifacts()) {
    const baseline = overlays.getBaseline(artifactId);
    if (!baseline) continue;

    const variants = overlays.listVariants(artifactId);
    const catalogVariants: CatalogVariant[] = variants.map(v => ({
      variantId: v.variantId,
      parentVariantId: v.parentVariantId,
      status: v.status as CatalogVariant['status'],
      payload: v.payload,
      evidenceRef: v.evidenceRef,
      ...(v.provenance ? { provenance: v.provenance } : {}),
    }));

    const promoted = variants.filter(v => v.status === ('promoted' as OverlayStatus));
    const active =
      promoted.length > 0 ? promoted[promoted.length - 1].variantId : null;

    const artifact: CatalogArtifact = {
      kind: baseline.kind,
      baseHash: baseline.baseHash,
      active,
      variants: catalogVariants,
    };
    catalog.artifacts[artifactId] = artifact;
  }
  return catalog;
}

/** Write the rebuilt catalog atomically. Corrupt existing file is preserved. */
export function writeCatalogFromOverlays(
  paths: LabPaths,
  overlays: OverlayStore,
  writeOptions?: WriteJsonAtomicOptions
): UpdateCatalogResult {
  return updateCatalog(
    paths.catalogPath,
    () => buildCatalogFromOverlays(overlays),
    writeOptions
  );
}

/**
 * Ensure a baseline entry exists for an artifact (used by tests and candidate
 * intake). Does not create a catalog entry by itself — catalog is rebuilt from
 * overlays.
 */
export function ensureArtifactBaseline(
  overlays: OverlayStore,
  artifactId: string,
  kind: CatalogArtifact['kind'],
  baselineText: string,
  description?: string
): string {
  const baseHash = computeBaseHash(baselineText);
  overlays.setBaseline(artifactId, kind, baseHash, description ?? baselineText.slice(0, 200));
  return baseHash;
}
