/**
 * AGP Context Manager (M_τ)
 *
 * Implements the complete operator set from Table 7 of the Autogenesis paper.
 * Each ResourceType has its own ContextManager instance that maintains the
 * registration record collection and version lineage.
 *
 * Operator categories:
 * - Lifecycle: init, build, register, unregister
 * - Retrieval: get, get_info, list, retrieve, get_state
 * - Versioning: update, copy, restore, get_variables, set_variables
 * - Execution: run
 * - Serialization: save_to_json, load_from_json, save_contract, load_contract
 */

import type {
  ResourceType,
  ResourceEntity,
  ResourceRegistrationRecord,
  VersionSnapshot,
  ResourceInfo,
  ResourceLifecycleState,
  ExportedRepresentation,
} from './protocol';
import { VersionManager, getVersionManager } from './version-manager';
import { incrementPatchVersion } from './types';
import * as fs from 'fs';
import * as path from 'path';

// ─── Internal Types ──────────────────────────────────────────────────────────

interface ManagedResource<T extends ResourceType = ResourceType> {
  record: ResourceRegistrationRecord<T>;
  lifecycleState: ResourceLifecycleState;
  /** Built instance (if applicable) */
  instance?: unknown;
}

/** Builder function: creates a resource instance from its registration record */
export type ResourceBuilder<T extends ResourceType = ResourceType> =
  (record: ResourceRegistrationRecord<T>) => Promise<unknown> | unknown;

/** Runner function: executes a resource with structured input */
export type ResourceRunner<T extends ResourceType = ResourceType> =
  (instance: unknown, input: unknown) => Promise<unknown> | unknown;

// ─── Context Manager ─────────────────────────────────────────────────────────

/**
 * ContextManager<T> — manages all resources of a specific type τ.
 *
 * Corresponds to M_τ in the Autogenesis paper (Def 3.3).
 */
export class ContextManager<T extends ResourceType = ResourceType> {
  /** Resource type this manager handles */
  readonly resourceType: T;

  /** Active registry: name → ManagedResource */
  private registry = new Map<string, ManagedResource<T>>();

  /** Optional builder for constructing resource instances */
  private builder?: ResourceBuilder<T>;

  /** Optional runner for executing resource instances */
  private runner?: ResourceRunner<T>;

  /** Version manager (shared across all types) */
  private versionManager: VersionManager;

  constructor(
    resourceType: T,
    options?: {
      builder?: ResourceBuilder<T>;
      runner?: ResourceRunner<T>;
      versionManager?: VersionManager;
    }
  ) {
    this.resourceType = resourceType;
    this.builder = options?.builder;
    this.runner = options?.runner;
    this.versionManager = options?.versionManager ?? getVersionManager();
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Lifecycle & Registration (init, build, register, unregister)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Register a new resource instance.
   * Creates a version snapshot and sets lifecycle to 'registered'.
   *
   * @returns The assigned version string
   */
  register(record: ResourceRegistrationRecord<T>): string {
    if (this.registry.has(record.entity.name)) {
      throw new Error(
        `Resource '${this.resourceType}:${record.entity.name}' is already registered. Use update() to modify.`
      );
    }

    const managed: ManagedResource<T> = {
      record: structuredClone(record),
      lifecycleState: 'registered',
    };

    this.registry.set(record.entity.name, managed);

    // Create initial version snapshot
    this.versionManager.createSnapshot(record, {
      resourceType: this.resourceType,
      commitMessage: `Initial registration of ${record.entity.name}`,
    });

    return record.version;
  }

  /**
   * Build a resource instance from its registration record.
   * Transitions lifecycle from 'registered' → 'built'.
   */
  async build(name: string): Promise<unknown> {
    const managed = this.getManaged(name);
    if (!this.builder) {
      throw new Error(`No builder configured for resource type '${this.resourceType}'`);
    }

    const instance = await this.builder(managed.record);
    managed.instance = instance;
    managed.lifecycleState = 'built';
    return instance;
  }

  /**
   * Unregister a resource. Removes from active registry and version lineage.
   */
  unregister(name: string): boolean {
    if (!this.registry.has(name)) return false;

    this.registry.delete(name);
    this.versionManager.removeLineage(this.resourceType, name);
    return true;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Retrieval & Inspection (get, get_info, list, retrieve, get_state)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Get a resource registration record by name.
   */
  get(name: string): ResourceRegistrationRecord<T> | null {
    const managed = this.registry.get(name);
    return managed ? managed.record : null;
  }

  /**
   * Get full resource info including lifecycle state and version lineage.
   */
  get_info(name: string): ResourceInfo<T> | null {
    const managed = this.registry.get(name);
    if (!managed) return null;

    const lineage = this.versionManager.getLineage(this.resourceType, name);
    return {
      record: managed.record,
      lifecycleState: managed.lifecycleState,
      versionLineage: lineage.map(s => s.version).reverse(),
    };
  }

  /**
   * List all registered resource names of this type.
   */
  list(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Retrieve resources matching a semantic query.
   * Uses simple substring matching on name + description (can be enhanced with embeddings).
   */
  retrieve(query: string, limit = 10): ResourceRegistrationRecord<T>[] {
    const lowerQuery = query.toLowerCase();
    const results: Array<{ record: ResourceRegistrationRecord<T>; score: number }> = [];

    for (const managed of this.registry.values()) {
      const nameScore = managed.record.entity.name.toLowerCase().includes(lowerQuery) ? 2 : 0;
      const descScore = managed.record.entity.description.toLowerCase().includes(lowerQuery) ? 1 : 0;
      const totalScore = nameScore + descScore;

      if (totalScore > 0) {
        results.push({ record: managed.record, score: totalScore });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit).map(r => r.record);
  }

  /**
   * Get the current runtime state of a resource instance.
   */
  get_state(name: string): unknown {
    const managed = this.registry.get(name);
    return managed?.instance ?? null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Versioning (update, copy, restore, get_variables, set_variables)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Update a resource with partial changes.
   * Creates a new version snapshot with the changes applied.
   *
   * @returns The new version string
   */
  update(
    name: string,
    changes: {
      entity?: Partial<ResourceEntity<T>>;
      implementationDescriptor?: string;
      instantiationParams?: Record<string, unknown>;
      exportedRepresentations?: ExportedRepresentation[];
      commitMessage?: string;
    }
  ): string {
    const managed = this.getManaged(name);
    const currentVersion = managed.record.version;
    const newVersion = incrementPatchVersion(currentVersion);

    // Apply changes to a copy
    const updatedRecord: ResourceRegistrationRecord<T> = {
      entity: {
        ...managed.record.entity,
        ...(changes.entity ?? {}),
        metadata: {
          ...managed.record.entity.metadata,
          ...(changes.entity?.metadata ?? {}),
        } as ResourceEntity<T>['metadata'],
      },
      version: newVersion,
      implementationDescriptor: changes.implementationDescriptor ?? managed.record.implementationDescriptor,
      instantiationParams: changes.instantiationParams ?? managed.record.instantiationParams,
      exportedRepresentations: changes.exportedRepresentations ?? managed.record.exportedRepresentations,
    };

    managed.record = updatedRecord;

    // Create version snapshot
    this.versionManager.createSnapshot(updatedRecord, {
      resourceType: this.resourceType,
      parentVersion: currentVersion,
      commitMessage: changes.commitMessage ?? `Update ${name}`,
    });

    return newVersion;
  }

  /**
   * Copy a resource with an optional new name.
   * The copy starts at version 1.0.0.
   */
  copy(sourceName: string, targetName?: string): ResourceRegistrationRecord<T> {
    const managed = this.getManaged(sourceName);
    const newName = targetName ?? `${sourceName}-copy`;

    const copiedRecord: ResourceRegistrationRecord<T> = {
      entity: {
        ...structuredClone(managed.record.entity),
        name: newName,
      },
      version: '1.0.0',
      implementationDescriptor: managed.record.implementationDescriptor,
      instantiationParams: structuredClone(managed.record.instantiationParams),
      exportedRepresentations: structuredClone(managed.record.exportedRepresentations),
    };

    this.register(copiedRecord);
    return copiedRecord;
  }

  /**
   * Restore a resource to a specific historical version.
   * Creates a new snapshot (rollback) to preserve lineage.
   */
  restore(name: string, targetVersion: string): ResourceRegistrationRecord<T> | null {
    const restored = this.versionManager.rollback<T>(
      this.resourceType,
      name,
      targetVersion,
      `Restore to v${targetVersion}`
    );

    if (!restored) return null;

    // Update the active registry entry
    const managed = this.registry.get(name);
    if (managed) {
      managed.record = restored;
    }

    return restored;
  }

  /**
   * Get evolvable variables from a resource.
   * Returns a record of variable name → current value for fields
   * marked as evolvable (g=1).
   */
  get_variables(name: string): Record<string, unknown> {
    const managed = this.getManaged(name);

    if (managed.record.entity.evolvability !== 1) {
      return {}; // Not evolvable
    }

    // Expose metadata fields as evolvable variables
    const variables: Record<string, unknown> = {};
    const metadata = managed.record.entity.metadata as Record<string, unknown>;

    for (const [key, value] of Object.entries(metadata)) {
      variables[key] = value;
    }

    // Also expose description as evolvable
    variables['description'] = managed.record.entity.description;

    return variables;
  }

  /**
   * Set evolvable variables on a resource.
   * Creates a new version with the updated variables.
   *
   * @returns The new version string
   */
  set_variables(name: string, variables: Record<string, unknown>): string {
    const managed = this.getManaged(name);

    if (managed.record.entity.evolvability !== 1) {
      throw new Error(`Resource '${name}' is not evolvable (g=0)`);
    }

    // Separate description from metadata variables
    const { description, ...metadataVars } = variables;
    const entityChanges: Partial<ResourceEntity<T>> = {};

    if (description !== undefined) {
      entityChanges.description = String(description);
    }

    if (Object.keys(metadataVars).length > 0) {
      entityChanges.metadata = {
        ...(managed.record.entity.metadata as Record<string, unknown>),
        ...metadataVars,
      } as ResourceEntity<T>['metadata'];
    }

    return this.update(name, {
      entity: entityChanges,
      commitMessage: `Set variables on ${name}: ${Object.keys(variables).join(', ')}`,
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Execution (run)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Run a resource instance with structured input.
   * Requires a runner to be configured and the resource to be built.
   */
  async run(name: string, input: unknown): Promise<unknown> {
    const managed = this.getManaged(name);

    if (!this.runner) {
      throw new Error(`No runner configured for resource type '${this.resourceType}'`);
    }

    // Auto-build if not yet built
    if (!managed.instance) {
      await this.build(name);
    }

    return this.runner(managed.instance, input);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Serialization (save_to_json, load_from_json, save_contract, load_contract)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Serialize all registration records and version history to a JSON file.
   */
  save_to_json(filePath: string): void {
    const data = {
      resourceType: this.resourceType,
      timestamp: Date.now(),
      records: Object.fromEntries(
        Array.from(this.registry.entries()).map(([name, managed]) => [
          name,
          {
            record: managed.record,
            lifecycleState: managed.lifecycleState,
          },
        ])
      ),
      lineage: this.versionManager.getLineage(this.resourceType, '') // Get all lineages for this type
        ? Object.fromEntries(
            this.list().map(name => [
              name,
              this.versionManager.getLineage(this.resourceType, name),
            ])
          )
        : {},
    };

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load registration records and version history from a JSON file.
   */
  load_from_json(filePath: string): void {
    if (!fs.existsSync(filePath)) return;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as {
      resourceType: T;
      records: Record<string, {
        record: ResourceRegistrationRecord<T>;
        lifecycleState: ResourceLifecycleState;
      }>;
    };

    if (data.resourceType !== this.resourceType) {
      throw new Error(`Resource type mismatch: expected ${this.resourceType}, got ${data.resourceType}`);
    }

    for (const [name, entry] of Object.entries(data.records)) {
      this.registry.set(name, {
        record: entry.record,
        lifecycleState: entry.lifecycleState,
      });
    }
  }

  /**
   * Save the contract (exported representations) of a resource to a file.
   */
  save_contract(name: string, filePath: string): void {
    const managed = this.getManaged(name);
    const contract = {
      resourceName: name,
      resourceType: this.resourceType,
      version: managed.record.version,
      description: managed.record.entity.description,
      evolvability: managed.record.entity.evolvability,
      exportedRepresentations: managed.record.exportedRepresentations,
    };

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(contract, null, 2), 'utf-8');
  }

  /**
   * Load a contract from a file and update the resource's exported representations.
   */
  load_contract(name: string, filePath: string): void {
    if (!fs.existsSync(filePath)) return;

    const raw = fs.readFileSync(filePath, 'utf-8');
    const contract = JSON.parse(raw) as {
      exportedRepresentations: ExportedRepresentation[];
    };

    const managed = this.getManaged(name);
    managed.record.exportedRepresentations = contract.exportedRepresentations;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // Internal Helpers
  // ════════════════════════════════════════════════════════════════════════════

  private getManaged(name: string): ManagedResource<T> {
    const managed = this.registry.get(name);
    if (!managed) {
      throw new Error(
        `Resource '${this.resourceType}:${name}' not found in registry. ` +
        `Available: [${this.list().join(', ')}]`
      );
    }
    return managed;
  }

  /**
   * Get all managed resources (for internal use by ServerInterface).
   */
  getAllManaged(): Map<string, ManagedResource<T>> {
    return this.registry;
  }

  /**
   * Get the underlying VersionManager.
   */
  getVersionManager(): VersionManager {
    return this.versionManager;
  }

  /**
   * Clear all registered resources (for testing).
   */
  clear(): void {
    this.registry.clear();
  }

  /**
   * Get count of registered resources.
   */
  get size(): number {
    return this.registry.size;
  }
}
