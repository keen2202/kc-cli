/**
 * AGP Version Manager
 *
 * Maintains version lineage for each resource, enabling rollback, branching,
 * and diffing. Each register/update creates an immutable snapshot.
 *
 * Corresponds to the Autogenesis paper's "Version manager" infrastructure
 * and the versioning operations in Table 7 (update, copy, restore,
 * get_variables, set_variables).
 */

import type {
  ResourceType,
  ResourceRegistrationRecord,
  VersionSnapshot,
  ResourceDiff,
} from './protocol';
import { incrementPatchVersion, compareVersions } from './types';

/**
 * Per-resource version lineage entry.
 */
interface VersionLineage {
  resourceName: string;
  resourceType: ResourceType;
  /** All version snapshots in chronological order */
  snapshots: VersionSnapshot[];
  /** Currently active version string */
  activeVersion: string;
  /** Branch name (default: "main") */
  branch: string;
}

/**
 * VersionManager manages version lineage for all registered resources.
 *
 * Key responsibilities:
 * - Create immutable snapshots on register/update
 * - Support rollback to any historical version
 * - Support branch creation from any version
 * - Compute diffs between two versions
 */
export class VersionManager {
  /** Map from "type:name" → VersionLineage */
  private lineages = new Map<string, VersionLineage>();

  // ─── Internal Key ──────────────────────────────────────────────────────────

  private lineageKey(type: ResourceType, name: string): string {
    return `${type}:${name}`;
  }

  // ─── Snapshot Creation ─────────────────────────────────────────────────────

  /**
   * Create a new version snapshot for a resource.
   * Called automatically by ContextManager on register/update.
   *
   * @returns The created snapshot
   */
  createSnapshot<T extends ResourceType>(
    record: ResourceRegistrationRecord<T>,
    options: {
      resourceType: T;
      parentVersion?: string;
      branch?: string;
      commitMessage?: string;
    }
  ): VersionSnapshot<T> {
    const key = this.lineageKey(options.resourceType, record.entity.name);

    let lineage = this.lineages.get(key);
    if (!lineage) {
      lineage = {
        resourceName: record.entity.name,
        resourceType: options.resourceType,
        snapshots: [],
        activeVersion: record.version,
        branch: options.branch ?? 'main',
      };
      this.lineages.set(key, lineage);
    }

    const snapshot: VersionSnapshot<T> = {
      resourceName: record.entity.name,
      resourceType: options.resourceType,
      version: record.version,
      timestamp: Date.now(),
      record: structuredClone(record),
      parentVersion: options.parentVersion ?? lineage.activeVersion,
      branch: options.branch ?? lineage.branch,
      commitMessage: options.commitMessage,
    };

    lineage.snapshots.push(snapshot as VersionSnapshot);
    lineage.activeVersion = record.version;

    return snapshot;
  }

  /**
   * Generate the next version string for a resource.
   * Increments the patch version of the currently active version.
   */
  nextVersion(type: ResourceType, name: string): string {
    const key = this.lineageKey(type, name);
    const lineage = this.lineages.get(key);
    if (!lineage || lineage.snapshots.length === 0) {
      return '1.0.0';
    }
    return incrementPatchVersion(lineage.activeVersion);
  }

  // ─── Lineage Retrieval ─────────────────────────────────────────────────────

  /**
   * Get the full version lineage for a resource.
   * Returns snapshots in chronological order.
   */
  getLineage(type: ResourceType, name: string): VersionSnapshot[] {
    const key = this.lineageKey(type, name);
    const lineage = this.lineages.get(key);
    return lineage ? [...lineage.snapshots] : [];
  }

  /**
   * Get a specific version snapshot.
   */
  getSnapshot(
    type: ResourceType,
    name: string,
    version: string
  ): VersionSnapshot | null {
    const lineage = this.getLineage(type, name);
    return lineage.find(s => s.version === version) ?? null;
  }

  /**
   * Get the currently active version string.
   */
  getActiveVersion(type: ResourceType, name: string): string | null {
    const key = this.lineageKey(type, name);
    const lineage = this.lineages.get(key);
    return lineage?.activeVersion ?? null;
  }

  /**
   * Get all version strings for a resource (newest first).
   */
  getVersionStrings(type: ResourceType, name: string): string[] {
    return this.getLineage(type, name)
      .map(s => s.version)
      .reverse();
  }

  // ─── Rollback ──────────────────────────────────────────────────────────────

  /**
   * Rollback a resource to a specific historical version.
   * Creates a new snapshot (copy of the target version) to preserve lineage.
   *
   * @returns The restored registration record, or null if version not found
   */
  rollback<T extends ResourceType>(
    type: T,
    name: string,
    targetVersion: string,
    commitMessage?: string
  ): ResourceRegistrationRecord<T> | null {
    const snapshot = this.getSnapshot(type, name, targetVersion);
    if (!snapshot) return null;

    const key = this.lineageKey(type, name);
    const lineage = this.lineages.get(key);
    if (!lineage) return null;

    // Create a new version from the target snapshot
    const newVersion = this.nextVersion(type, name);
    const restoredRecord: ResourceRegistrationRecord<T> = {
      ...structuredClone(snapshot.record),
      version: newVersion,
    };

    this.createSnapshot(restoredRecord, {
      resourceType: type,
      parentVersion: lineage.activeVersion,
      commitMessage: commitMessage ?? `Rollback to v${targetVersion}`,
    });

    return restoredRecord;
  }

  // ─── Branching ─────────────────────────────────────────────────────────────

  /**
   * Create a version branch from a specific version.
   * Returns the branch identifier.
   */
  branch(
    type: ResourceType,
    name: string,
    fromVersion: string,
    branchName: string
  ): string | null {
    const snapshot = this.getSnapshot(type, name, fromVersion);
    if (!snapshot) return null;

    const key = this.lineageKey(type, name);
    const lineage = this.lineages.get(key);
    if (!lineage) return null;

    // Create a new snapshot marking the branch point
    const branchRecord = structuredClone(snapshot.record);
    this.createSnapshot(branchRecord, {
      resourceType: type,
      parentVersion: fromVersion,
      branch: branchName,
      commitMessage: `Branch '${branchName}' from v${fromVersion}`,
    });

    return branchName;
  }

  // ─── Diff ──────────────────────────────────────────────────────────────────

  /**
   * Compute a diff between two versions of a resource.
   */
  diff(
    type: ResourceType,
    name: string,
    fromVersion: string,
    toVersion: string
  ): ResourceDiff | null {
    const fromSnap = this.getSnapshot(type, name, fromVersion);
    const toSnap = this.getSnapshot(type, name, toVersion);
    if (!fromSnap || !toSnap) return null;

    const changes: ResourceDiff['changes'] = [];
    const fromEntity = fromSnap.record.entity;
    const toEntity = toSnap.record.entity;

    // Compare entity fields
    if (fromEntity.description !== toEntity.description) {
      changes.push({
        field: 'description',
        oldValue: fromEntity.description,
        newValue: toEntity.description,
      });
    }
    if (fromEntity.evolvability !== toEntity.evolvability) {
      changes.push({
        field: 'evolvability',
        oldValue: fromEntity.evolvability,
        newValue: toEntity.evolvability,
      });
    }

    // Compare implementation descriptor
    if (fromSnap.record.implementationDescriptor !== toSnap.record.implementationDescriptor) {
      changes.push({
        field: 'implementationDescriptor',
        oldValue: fromSnap.record.implementationDescriptor,
        newValue: toSnap.record.implementationDescriptor,
      });
    }

    // Compare metadata (shallow)
    const fromMeta = fromEntity.metadata as Record<string, unknown>;
    const toMeta = toEntity.metadata as Record<string, unknown>;
    const allKeys = new Set([...Object.keys(fromMeta), ...Object.keys(toMeta)]);
    for (const key of allKeys) {
      const oldVal = fromMeta[key];
      const newVal = toMeta[key];
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changes.push({ field: `metadata.${key}`, oldValue: oldVal, newValue: newVal });
      }
    }

    return {
      resourceName: name,
      fromVersion,
      toVersion,
      changes,
      evolvabilityChanged: fromEntity.evolvability !== toEntity.evolvability,
    };
  }

  // ─── Cleanup ───────────────────────────────────────────────────────────────

  /**
   * Remove all lineage data for a resource (called on unregister).
   */
  removeLineage(type: ResourceType, name: string): void {
    const key = this.lineageKey(type, name);
    this.lineages.delete(key);
  }

  /**
   * Get all tracked resource keys.
   */
  getTrackedResources(): string[] {
    return Array.from(this.lineages.keys());
  }

  /**
   * Clear all lineage data (for testing).
   */
  clear(): void {
    this.lineages.clear();
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  /**
   * Serialize all lineages to a JSON-compatible structure.
   */
  serialize(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, lineage] of this.lineages.entries()) {
      result[key] = {
        resourceName: lineage.resourceName,
        resourceType: lineage.resourceType,
        activeVersion: lineage.activeVersion,
        branch: lineage.branch,
        snapshots: lineage.snapshots.map(s => ({
          ...s,
          record: s.record,
        })),
      };
    }
    return result;
  }

  /**
   * Restore lineages from serialized data.
   */
  deserialize(data: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(data)) {
      const lineage = value as VersionLineage;
      this.lineages.set(key, {
        resourceName: lineage.resourceName,
        resourceType: lineage.resourceType,
        activeVersion: lineage.activeVersion,
        branch: lineage.branch ?? 'main',
        snapshots: lineage.snapshots ?? [],
      });
    }
  }
}

/**
 * Global VersionManager singleton.
 */
let globalVersionManager: VersionManager | null = null;

export function getVersionManager(): VersionManager {
  if (!globalVersionManager) {
    globalVersionManager = new VersionManager();
  }
  return globalVersionManager;
}

export function resetVersionManager(): void {
  globalVersionManager?.clear();
  globalVersionManager = null;
}
