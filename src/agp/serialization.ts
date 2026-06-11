/**
 * AGP Resource Serialization
 *
 * Implements save_to_json / load_from_json for cross-process state recovery.
 * Handles serialization of the complete AGP registry state including:
 * - All resource registrations
 * - Version lineages
 * - Trace data
 * - Evolution state
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ServerInterface } from './server-interface';
import type { VersionManager } from './version-manager';
import type { TraceManager } from './trace-manager';
import type { ResourceType, ResourceRegistrationRecord } from './protocol';
import { RESOURCE_TYPES } from './protocol';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SerializedRegistryState {
  /** Schema version for forward compatibility */
  schemaVersion: number;
  /** Serialization timestamp */
  serializedAt: number;
  /** Serialized resources by type */
  resources: Record<string, SerializedResource[]>;
  /** Serialized version lineages */
  lineages: SerializedLineage[];
  /** Serialized trace data */
  traces?: Record<string, unknown>;
  /** Metadata */
  metadata: {
    totalResources: number;
    totalVersions: number;
    sessionCount: number;
  };
}

interface SerializedResource {
  type: ResourceType;
  name: string;
  record: Record<string, unknown>;
}

interface SerializedLineage {
  type: ResourceType;
  name: string;
  versions: Array<{
    version: string;
    timestamp: number;
    commitMessage?: string;
    record: Record<string, unknown>;
  }>;
}

// ─── Serialization ───────────────────────────────────────────────────────────

export class ResourceSerializer {
  private serverInterface: ServerInterface;
  private versionManager: VersionManager;
  private traceManager: TraceManager;
  private persistDir: string;

  constructor(
    serverInterface: ServerInterface,
    versionManager: VersionManager,
    traceManager: TraceManager,
    persistDir: string
  ) {
    this.serverInterface = serverInterface;
    this.versionManager = versionManager;
    this.traceManager = traceManager;
    this.persistDir = persistDir;
  }

  /**
   * Serialize the complete registry state to JSON.
   */
  serialize(): SerializedRegistryState {
    const resources: Record<string, SerializedResource[]> = {};
    let totalResources = 0;
    let totalVersions = 0;

    // Serialize resources by type
    for (const type of RESOURCE_TYPES) {
      const typeResources: SerializedResource[] = [];
      try {
        const names = this.serverInterface.list(type);
        for (const name of names) {
          try {
            const resp = this.serverInterface.get_info(type, name);
            if (resp.success && resp.data) {
              typeResources.push({
                type,
                name,
                record: this.serializeRecord(resp.data.record),
              });
              totalResources++;
            }
          } catch {
            // Skip inaccessible resources
          }
        }
      } catch {
        // Skip inaccessible type
      }
      resources[type] = typeResources;
    }

    // Serialize version lineages
    const lineages: SerializedLineage[] = [];
    for (const type of RESOURCE_TYPES) {
      try {
        const names = this.serverInterface.list(type);
        for (const name of names) {
          try {
            const lineage = this.versionManager.getLineage(type, name);
            if (lineage.length > 0) {
              lineages.push({
                type,
                name,
                versions: lineage.map(snap => ({
                  version: snap.version,
                  timestamp: snap.timestamp,
                  commitMessage: snap.commitMessage,
                  record: this.serializeRecord(snap.record),
                })),
              });
              totalVersions += lineage.length;
            }
          } catch {
            // Skip
          }
        }
      } catch {
        // Skip
      }
    }

    return {
      schemaVersion: 1,
      serializedAt: Date.now(),
      resources,
      lineages,
      traces: this.traceManager.serialize(),
      metadata: {
        totalResources,
        totalVersions,
        sessionCount: this.traceManager.getSessionIds().length,
      },
    };
  }

  /**
   * Restore registry state from serialized JSON.
   */
  deserialize(state: SerializedRegistryState): { restored: number; errors: string[] } {
    let restored = 0;
    const errors: string[] = [];

    // Restore resources
    for (const type of RESOURCE_TYPES) {
      const typeResources = state.resources[type] ?? [];
      for (const resource of typeResources) {
        try {
          const record = this.deserializeRecord(resource.record);
          this.serverInterface.register(type, record);
          restored++;
        } catch (error) {
          errors.push(`Failed to restore ${type}:${resource.name}: ${error}`);
        }
      }
    }

    // Restore traces
    if (state.traces) {
      try {
        this.traceManager.deserialize(state.traces);
      } catch (error) {
        errors.push(`Failed to restore traces: ${error}`);
      }
    }

    return { restored, errors };
  }

  /**
   * Save state to disk.
   */
  async saveToFile(filename?: string): Promise<void> {
    const state = this.serialize();
    const filePath = path.join(this.persistDir, filename ?? 'agp-state.json');

    await fs.promises.mkdir(this.persistDir, { recursive: true });
    await fs.promises.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Load state from disk.
   */
  async loadFromFile(filename?: string): Promise<{ restored: number; errors: string[] }> {
    const filePath = path.join(this.persistDir, filename ?? 'agp-state.json');

    try {
      const data = await fs.promises.readFile(filePath, 'utf-8');
      const state = JSON.parse(data) as SerializedRegistryState;

      if (state.schemaVersion !== 1) {
        return { restored: 0, errors: [`Unsupported schema version: ${state.schemaVersion}`] };
      }

      return this.deserialize(state);
    } catch (error) {
      return { restored: 0, errors: [`Failed to load state: ${error}`] };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  /**
   * Serialize a registration record to a plain object.
   * Strips non-serializable fields (functions, class instances).
   */
  private serializeRecord(record: ResourceRegistrationRecord): Record<string, unknown> {
    return {
      entity: {
        name: record.entity.name,
        description: record.entity.description,
        evolvability: record.entity.evolvability,
        metadata: record.entity.metadata,
        ioMapping: {
          inputSchema: record.entity.ioMapping.inputSchema,
          outputSchema: record.entity.ioMapping.outputSchema,
          // callable is not serializable
        },
      },
      version: record.version,
      implementationDescriptor: record.implementationDescriptor,
      instantiationParams: record.instantiationParams,
      exportedRepresentations: record.exportedRepresentations,
    };
  }

  /**
   * Deserialize a plain object back to a registration record.
   */
  private deserializeRecord(data: Record<string, unknown>): ResourceRegistrationRecord {
    const entity = data.entity as Record<string, unknown>;
    const ioMapping = (entity.ioMapping as Record<string, unknown>) ?? {};

    return {
      entity: {
        name: entity.name as string,
        description: entity.description as string,
        evolvability: (entity.evolvability as 0 | 1) ?? 0,
        metadata: (entity.metadata ?? {}) as any,
        ioMapping: {
          inputSchema: ioMapping.inputSchema as string | Record<string, unknown> | undefined,
          outputSchema: ioMapping.outputSchema as string | Record<string, unknown> | undefined,
        },
      },
      version: data.version as string,
      implementationDescriptor: data.implementationDescriptor as string,
      instantiationParams: (data.instantiationParams ?? {}) as Record<string, unknown>,
      exportedRepresentations: (data.exportedRepresentations ?? []) as any[],
    };
  }
}
