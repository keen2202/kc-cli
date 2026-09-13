/**
 * Overlay store — baseline description, baseHash, variant payload, status.
 *
 * Offline lab only. Status values match catalog.json:
 *   candidate | promoted | retired | rejected
 *
 * Layout: <labRoot>/lab/overlays.json  (kc.agp.overlays.v1)
 */

import {
  OVERLAYS_FORMAT,
  readJsonSafe,
  writeJsonAtomic,
  type LabPaths,
} from './lab-paths';
import type { ArtifactKind } from '../../src/experiments/protocol';
import { VersionStore } from './version-store';

export type OverlayStatus = 'candidate' | 'promoted' | 'retired' | 'rejected';

export interface OverlayProvenance {
  source?: string;
  labRunId?: string;
  promotedBy?: string;
  promotedAt?: number;
  reason?: string;
}

export interface OverlayVariant {
  variantId: string;
  parentVariantId: string | null;
  payload: string | Record<string, unknown>;
  status: OverlayStatus;
  evidenceRef: string;
  provenance?: OverlayProvenance;
  createdAt: number;
  updatedAt: number;
}

export interface OverlayBaseline {
  kind: ArtifactKind;
  /** SHA-256 of the canonical code baseline (drift detection). */
  baseHash: string;
  /** Human-readable description of the baseline surface / policy. */
  description: string;
  updatedAt: number;
}

export interface OverlayArtifactState {
  baseline: OverlayBaseline;
  variants: Record<string, OverlayVariant>;
}

export interface OverlaysFile {
  format: typeof OVERLAYS_FORMAT;
  artifacts: Record<string, OverlayArtifactState>;
}

/** Allowed status transitions. Terminal states accept no further migration. */
const STATUS_TRANSITIONS: Record<OverlayStatus, OverlayStatus[]> = {
  candidate: ['promoted', 'rejected', 'retired'],
  promoted: ['retired'],
  retired: [],
  rejected: [],
};

export function isStatusTransitionAllowed(
  from: OverlayStatus,
  to: OverlayStatus
): boolean {
  if (from === to) return true;
  return STATUS_TRANSITIONS[from].includes(to);
}

function emptyOverlaysFile(): OverlaysFile {
  return { format: OVERLAYS_FORMAT, artifacts: {} };
}

export interface PutVariantInput {
  artifactId: string;
  kind: ArtifactKind;
  baseHash: string;
  baselineDescription: string;
  variantId: string;
  parentVariantId?: string | null;
  payload: string | Record<string, unknown>;
  evidenceRef: string;
  provenance?: OverlayProvenance;
  /** Initial status. Default: candidate. */
  status?: OverlayStatus;
}

export class OverlayStore {
  private readonly overlaysPath: string;
  private data: OverlaysFile;
  private readonly versions: VersionStore | undefined;

  constructor(paths: LabPaths, versions?: VersionStore) {
    this.overlaysPath = paths.overlaysPath;
    this.versions = versions;
    this.data = this.load();
  }

  private load(): OverlaysFile {
    const result = readJsonSafe<OverlaysFile>(this.overlaysPath);
    if (!result.ok) {
      if (result.reason === 'corrupt') {
        throw new Error(
          `overlay store corrupt (${this.overlaysPath}): ${result.message}. Refusing to continue; recover or archive the file.`
        );
      }
      return emptyOverlaysFile();
    }
    const value = result.value;
    if (!value || typeof value !== 'object' || value.format !== OVERLAYS_FORMAT) {
      return emptyOverlaysFile();
    }
    if (!value.artifacts || typeof value.artifacts !== 'object') {
      return emptyOverlaysFile();
    }
    return value;
  }

  private persist(): void {
    writeJsonAtomic(this.overlaysPath, this.data);
  }

  private ensureArtifact(input: {
    artifactId: string;
    kind: ArtifactKind;
    baseHash: string;
    baselineDescription: string;
  }): OverlayArtifactState {
    let state = this.data.artifacts[input.artifactId];
    if (!state) {
      state = {
        baseline: {
          kind: input.kind,
          baseHash: input.baseHash,
          description: input.baselineDescription,
          updatedAt: Date.now(),
        },
        variants: {},
      };
      this.data.artifacts[input.artifactId] = state;
      return state;
    }
    // Refresh baseline description / hash if the caller supplies a newer one.
    if (
      state.baseline.baseHash !== input.baseHash ||
      state.baseline.description !== input.baselineDescription
    ) {
      state.baseline = {
        kind: input.kind,
        baseHash: input.baseHash,
        description: input.baselineDescription,
        updatedAt: Date.now(),
      };
    }
    return state;
  }

  setBaseline(
    artifactId: string,
    kind: ArtifactKind,
    baseHash: string,
    description: string
  ): OverlayBaseline {
    const state = this.ensureArtifact({ artifactId, kind, baseHash, description });
    this.persist();
    return { ...state.baseline };
  }

  getBaseline(artifactId: string): OverlayBaseline | null {
    const state = this.data.artifacts[artifactId];
    return state ? { ...state.baseline } : null;
  }

  /** Insert (or replace payload of) a candidate variant. Immutable once non-candidate. */
  putVariant(input: PutVariantInput): OverlayVariant {
    const state = this.ensureArtifact({
      artifactId: input.artifactId,
      kind: input.kind,
      baseHash: input.baseHash,
      baselineDescription: input.baselineDescription,
    });

    const existing = state.variants[input.variantId];
    if (existing && existing.status !== 'candidate') {
      throw new Error(
        `overlay store: variant ${input.variantId} is ${existing.status}; payload is immutable after leaving candidate`
      );
    }

    const now = Date.now();
    const status = input.status ?? existing?.status ?? 'candidate';
    const variant: OverlayVariant = {
      variantId: input.variantId,
      parentVariantId:
        input.parentVariantId !== undefined
          ? input.parentVariantId
          : (existing?.parentVariantId ?? null),
      payload: input.payload,
      status,
      evidenceRef: input.evidenceRef,
      ...(input.provenance ?? existing?.provenance
        ? { provenance: input.provenance ?? existing?.provenance }
        : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    state.variants[input.variantId] = variant;
    this.persist();

    // Lineage snapshot only on first insert — candidates may be updated in place.
    if (!existing && this.versions) {
      const already = this.versions.getSnapshot(input.artifactId, input.variantId);
      if (!already) {
        this.versions.snapshot(input.artifactId, {
          variantId: input.variantId,
          parentVariantId: variant.parentVariantId,
          commitMessage: `overlay ${input.variantId}`,
          status: variant.status,
          timestamp: now,
        });
      }
    }

    return { ...variant };
  }

  getVariant(artifactId: string, variantId: string): OverlayVariant | null {
    const state = this.data.artifacts[artifactId];
    const variant = state?.variants[variantId];
    return variant ? { ...variant } : null;
  }

  listArtifacts(): string[] {
    return Object.keys(this.data.artifacts).sort();
  }

  listVariants(artifactId: string): OverlayVariant[] {
    const state = this.data.artifacts[artifactId];
    if (!state) return [];
    return Object.values(state.variants)
      .map(v => ({ ...v }))
      .sort((a, b) => a.createdAt - b.createdAt || a.variantId.localeCompare(b.variantId));
  }

  /**
   * Migrate variant status. Illegal transitions are rejected without mutating
   * the store. Promoted variants are stamped into the version lineage.
   */
  setStatus(
    artifactId: string,
    variantId: string,
    status: OverlayStatus,
    provenance?: OverlayProvenance
  ): { ok: true; variant: OverlayVariant } | { ok: false; reason: string } {
    const state = this.data.artifacts[artifactId];
    const variant = state?.variants[variantId];
    if (!variant) {
      return { ok: false, reason: `unknown variant ${artifactId}/${variantId}` };
    }
    if (!isStatusTransitionAllowed(variant.status, status)) {
      return {
        ok: false,
        reason: `illegal status transition ${variant.status} → ${status}`,
      };
    }

    variant.status = status;
    variant.updatedAt = Date.now();
    if (provenance) {
      variant.provenance = { ...variant.provenance, ...provenance };
    }
    this.persist();

    try {
      this.versions?.stampStatus(artifactId, variantId, status);
    } catch {
      /* lineage stamp is best-effort; overlay status already persisted */
    }

    return { ok: true, variant: { ...variant } };
  }

  /**
   * Archive a variant = mark it retired (terminal). Same as setStatus retired
   * but always allowed from candidate/promoted and never from rejected.
   */
  archive(artifactId: string, variantId: string): { ok: true; variant: OverlayVariant } | { ok: false; reason: string } {
    return this.setStatus(artifactId, variantId, 'retired', { reason: 'archive' });
  }
}

export function createOverlayStore(paths: LabPaths, versions?: VersionStore): OverlayStore {
  return new OverlayStore(paths, versions);
}
