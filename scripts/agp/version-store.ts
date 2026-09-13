/**
 * File-based version lineage for the offline AGP lab.
 *
 * Reworked from src/agp/version-manager.ts (in-memory ResourceRegistrationRecord
 * lineage) into an on-disk store keyed by artifactId. Supports snapshot, parent,
 * branch, diff, and active-pointer queries. Payload bytes live in overlay-store;
 * this store keeps the graph only.
 *
 * Layout: <labRoot>/lab/versions.json  (kc.agp.versions.v1)
 */

import {
  VERSIONS_FORMAT,
  readJsonSafe,
  writeJsonAtomic,
  type LabPaths,
} from './lab-paths';

export interface VersionSnapshot {
  variantId: string;
  parentVariantId: string | null;
  branch: string;
  timestamp: number;
  commitMessage?: string;
  /** Status at the time of the snapshot (lineage audit trail). */
  status?: string;
}

export interface VersionLineage {
  artifactId: string;
  /** Current branch name. */
  branch: string;
  activeVariantId: string | null;
  snapshots: VersionSnapshot[];
}

export interface VersionsFile {
  format: typeof VERSIONS_FORMAT;
  lineages: Record<string, VersionLineage>;
}

export interface VersionDiffField {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface VersionDiff {
  artifactId: string;
  fromVariantId: string;
  toVariantId: string;
  changes: VersionDiffField[];
}

export interface SnapshotInput {
  variantId: string;
  parentVariantId?: string | null;
  branch?: string;
  commitMessage?: string;
  status?: string;
  timestamp?: number;
}

function emptyVersionsFile(): VersionsFile {
  return { format: VERSIONS_FORMAT, lineages: {} };
}

function cloneLineage(lineage: VersionLineage): VersionLineage {
  return {
    artifactId: lineage.artifactId,
    branch: lineage.branch,
    activeVariantId: lineage.activeVariantId,
    snapshots: lineage.snapshots.map(s => ({ ...s })),
  };
}

export class VersionStore {
  private readonly versionsPath: string;
  private data: VersionsFile;

  constructor(paths: LabPaths) {
    this.versionsPath = paths.versionsPath;
    this.data = this.load();
  }

  private load(): VersionsFile {
    const result = readJsonSafe<VersionsFile>(this.versionsPath);
    if (!result.ok) {
      if (result.reason === 'corrupt') {
        throw new Error(
          `version store corrupt (${this.versionsPath}): ${result.message}. Refusing to continue; recover or archive the file.`
        );
      }
      return emptyVersionsFile();
    }
    const value = result.value;
    if (!value || typeof value !== 'object' || value.format !== VERSIONS_FORMAT) {
      return emptyVersionsFile();
    }
    if (!value.lineages || typeof value.lineages !== 'object') {
      return emptyVersionsFile();
    }
    return value;
  }

  private persist(): void {
    writeJsonAtomic(this.versionsPath, this.data);
  }

  private ensureLineage(artifactId: string): VersionLineage {
    let lineage = this.data.lineages[artifactId];
    if (!lineage) {
      lineage = {
        artifactId,
        branch: 'main',
        activeVariantId: null,
        snapshots: [],
      };
      this.data.lineages[artifactId] = lineage;
    }
    return lineage;
  }

  // ─── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * Create an immutable snapshot. Defaults parent to the current active variant
   * when omitted (null parent is explicit for the first variant).
   */
  snapshot(artifactId: string, input: SnapshotInput): VersionSnapshot {
    const lineage = this.ensureLineage(artifactId);
    if (lineage.snapshots.some(s => s.variantId === input.variantId)) {
      throw new Error(
        `version store: variant ${input.variantId} already snapshotted for ${artifactId}`
      );
    }

    const parent =
      input.parentVariantId !== undefined
        ? input.parentVariantId
        : lineage.activeVariantId;

    if (parent !== null && !lineage.snapshots.some(s => s.variantId === parent)) {
      throw new Error(
        `version store: parent ${parent} not found for ${artifactId}`
      );
    }

    const branch = input.branch ?? lineage.branch;
    const snap: VersionSnapshot = {
      variantId: input.variantId,
      parentVariantId: parent,
      branch,
      timestamp: input.timestamp ?? Date.now(),
      ...(input.commitMessage !== undefined ? { commitMessage: input.commitMessage } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    };

    lineage.snapshots.push(snap);
    if (branch !== lineage.branch) {
      lineage.branch = branch;
    }
    lineage.activeVariantId = snap.variantId;
    this.persist();
    return { ...snap };
  }

  // ─── Queries ───────────────────────────────────────────────────────────────

  getLineage(artifactId: string): VersionLineage | null {
    const lineage = this.data.lineages[artifactId];
    return lineage ? cloneLineage(lineage) : null;
  }

  getSnapshot(artifactId: string, variantId: string): VersionSnapshot | null {
    const lineage = this.data.lineages[artifactId];
    if (!lineage) return null;
    const snap = lineage.snapshots.find(s => s.variantId === variantId);
    return snap ? { ...snap } : null;
  }

  /** Direct parent of a variant, or null when missing / root. */
  getParent(artifactId: string, variantId: string): VersionSnapshot | null {
    const snap = this.getSnapshot(artifactId, variantId);
    if (!snap || snap.parentVariantId === null) return null;
    return this.getSnapshot(artifactId, snap.parentVariantId);
  }

  getActive(artifactId: string): VersionSnapshot | null {
    const lineage = this.data.lineages[artifactId];
    if (!lineage?.activeVariantId) return null;
    return this.getSnapshot(artifactId, lineage.activeVariantId);
  }

  /** Move the active pointer. Target must already exist in the lineage. */
  setActive(artifactId: string, variantId: string): VersionSnapshot {
    const lineage = this.ensureLineage(artifactId);
    const snap = lineage.snapshots.find(s => s.variantId === variantId);
    if (!snap) {
      throw new Error(`version store: cannot activate unknown variant ${variantId}`);
    }
    lineage.activeVariantId = variantId;
    this.persist();
    return { ...snap };
  }

  listArtifacts(): string[] {
    return Object.keys(this.data.lineages).sort();
  }

  listVariants(artifactId: string): VersionSnapshot[] {
    const lineage = this.data.lineages[artifactId];
    return lineage ? lineage.snapshots.map(s => ({ ...s })) : [];
  }

  // ─── Branch ────────────────────────────────────────────────────────────────

  /**
   * Create a named branch starting at fromVariantId. The branch snapshot is a
   * copy of the source version tagged with the new branch name.
   */
  branch(
    artifactId: string,
    fromVariantId: string,
    branchName: string
  ): VersionSnapshot {
    const lineage = this.ensureLineage(artifactId);
    const source = lineage.snapshots.find(s => s.variantId === fromVariantId);
    if (!source) {
      throw new Error(
        `version store: cannot branch ${branchName} from unknown ${fromVariantId}`
      );
    }
    if (!branchName || branchName.trim() === '') {
      throw new Error('version store: branch name required');
    }

    const branchVariantId = `${fromVariantId}+${branchName}`;
    if (lineage.snapshots.some(s => s.variantId === branchVariantId)) {
      throw new Error(
        `version store: branch variant ${branchVariantId} already exists`
      );
    }

    const snap: VersionSnapshot = {
      variantId: branchVariantId,
      parentVariantId: fromVariantId,
      branch: branchName,
      timestamp: Date.now(),
      commitMessage: `Branch '${branchName}' from ${fromVariantId}`,
      ...(source.status !== undefined ? { status: source.status } : {}),
    };
    lineage.snapshots.push(snap);
    lineage.branch = branchName;
    lineage.activeVariantId = snap.variantId;
    this.persist();
    return { ...snap };
  }

  // ─── Diff ──────────────────────────────────────────────────────────────────

  /**
   * Diff two snapshots of the same artifact. Compares lineage fields only
   * (payload bytes live in overlay-store and are compared by catalog-writer).
   */
  diff(
    artifactId: string,
    fromVariantId: string,
    toVariantId: string
  ): VersionDiff | null {
    const from = this.getSnapshot(artifactId, fromVariantId);
    const to = this.getSnapshot(artifactId, toVariantId);
    if (!from || !to) return null;

    const changes: VersionDiffField[] = [];
    const fields: Array<keyof VersionSnapshot> = [
      'parentVariantId',
      'branch',
      'commitMessage',
      'status',
    ];
    for (const field of fields) {
      const oldValue = from[field];
      const newValue = to[field];
      if (oldValue !== newValue) {
        changes.push({ field, oldValue, newValue });
      }
    }
    return {
      artifactId,
      fromVariantId,
      toVariantId,
      changes,
    };
  }

  // ─── Status trail (lineage view) ───────────────────────────────────────────

  /**
   * Stamp the latest status onto an existing snapshot (does not create a new
   * version). Used by overlay-store status migration so the lineage keeps an
   * audit of the terminal state of each variant.
   */
  stampStatus(artifactId: string, variantId: string, status: string): VersionSnapshot {
    const lineage = this.ensureLineage(artifactId);
    const snap = lineage.snapshots.find(s => s.variantId === variantId);
    if (!snap) {
      throw new Error(`version store: cannot stamp status on unknown ${variantId}`);
    }
    snap.status = status;
    this.persist();
    return { ...snap };
  }
}

export function createVersionStore(paths: LabPaths): VersionStore {
  return new VersionStore(paths);
}
