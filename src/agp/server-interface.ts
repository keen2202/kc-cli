/**
 * AGP Server Interface (A_τ)
 *
 * Encapsulates the ContextManager's internal complexity and presents a
 * stable, unified external interface. All SEPL operators MUST route
 * mutations through this interface to guarantee:
 * - All changes are version-controlled
 * - Automatic snapshot creation on every mutation
 * - Callers don't need to know ContextManager internals
 *
 * Corresponds to A_τ in the Autogenesis paper (Def 3.3).
 */

import type {
  ResourceType,
  ResourceRegistrationRecord,
  ResourceEntity,
  ResourceInfo,
  ExportedRepresentation,
  VersionSnapshot,
  ResourceDiff,
} from './protocol';
import type { ContextManager, ResourceBuilder, ResourceRunner } from './context-manager';

// ─── Request/Response Types ──────────────────────────────────────────────────

export interface ServerRequest {
  operation: string;
  resourceName?: string;
  payload?: Record<string, unknown>;
}

export interface ServerResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  version?: string;
}

// ─── Server Interface ────────────────────────────────────────────────────────

/**
 * ServerInterface provides a uniform facade over one or more ContextManagers.
 *
 * This is the single control plane through which SEPL operators interact
 * with RSPL resources, ensuring all mutations are versioned and auditable.
 */
export class ServerInterface {
  /** Map from ResourceType → ContextManager */
  private managers = new Map<ResourceType, ContextManager>();

  /**
   * Register a ContextManager for a resource type.
   */
  registerManager<T extends ResourceType>(manager: ContextManager<T>): void {
    this.managers.set(manager.resourceType, manager as ContextManager);
  }

  /**
   * Get the ContextManager for a specific resource type.
   */
  getManager<T extends ResourceType>(type: T): ContextManager<T> | undefined {
    return this.managers.get(type) as ContextManager<T> | undefined;
  }

  // ─── Unified Operations ──────────────────────────────────────────────────

  /**
   * Register a resource of any type.
   */
  register<T extends ResourceType>(
    type: T,
    record: ResourceRegistrationRecord<T>
  ): ServerResponse<{ version: string }> {
    const manager = this.requireManager(type);
    try {
      const version = manager.register(record);
      return { success: true, version, data: { version } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Update a resource of any type.
   */
  update<T extends ResourceType>(
    type: T,
    name: string,
    changes: {
      entity?: Partial<ResourceEntity<T>>;
      implementationDescriptor?: string;
      instantiationParams?: Record<string, unknown>;
      exportedRepresentations?: ExportedRepresentation[];
      commitMessage?: string;
    }
  ): ServerResponse<{ version: string }> {
    const manager = this.requireManager(type);
    try {
      const version = manager.update(name, changes);
      return { success: true, version, data: { version } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Get a resource record.
   */
  get<T extends ResourceType>(
    type: T,
    name: string
  ): ServerResponse<ResourceRegistrationRecord<T>> {
    const manager = this.requireManager(type);
    const record = manager.get(name);
    if (!record) {
      return { success: false, error: `Resource '${type}:${name}' not found` };
    }
    return { success: true, data: record };
  }

  /**
   * Get full resource info.
   */
  get_info<T extends ResourceType>(
    type: T,
    name: string
  ): ServerResponse<ResourceInfo<T>> {
    const manager = this.requireManager(type);
    const info = manager.get_info(name);
    if (!info) {
      return { success: false, error: `Resource '${type}:${name}' not found` };
    }
    return { success: true, data: info };
  }

  /**
   * List all resource names of a given type.
   */
  list(type: ResourceType): string[] {
    const manager = this.managers.get(type);
    return manager ? manager.list() : [];
  }

  /**
   * List all resource names across all types.
   */
  listAll(): Array<{ type: ResourceType; name: string }> {
    const results: Array<{ type: ResourceType; name: string }> = [];
    for (const [type, manager] of this.managers) {
      for (const name of manager.list()) {
        results.push({ type, name });
      }
    }
    return results;
  }

  /**
   * Retrieve resources matching a semantic query across all types.
   */
  retrieve(query: string, limit = 10): ResourceRegistrationRecord[] {
    const results: ResourceRegistrationRecord[] = [];
    for (const manager of this.managers.values()) {
      results.push(...manager.retrieve(query, limit));
    }
    // Sort by relevance (crude scoring: name match > description match)
    return results.slice(0, limit);
  }

  /**
   * Unregister a resource.
   */
  unregister(type: ResourceType, name: string): ServerResponse {
    const manager = this.requireManager(type);
    const removed = manager.unregister(name);
    return removed
      ? { success: true }
      : { success: false, error: `Resource '${type}:${name}' not found` };
  }

  /**
   * Set evolvable variables on a resource (SEPL mutation point).
   * All SEPL Improve operators MUST call this method to apply changes.
   */
  set_variables<T extends ResourceType>(
    type: T,
    name: string,
    variables: Record<string, unknown>
  ): ServerResponse<{ version: string }> {
    const manager = this.requireManager(type);
    try {
      const version = manager.set_variables(name, variables);
      return { success: true, version, data: { version } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Get evolvable variables from a resource.
   */
  get_variables<T extends ResourceType>(
    type: T,
    name: string
  ): ServerResponse<Record<string, unknown>> {
    const manager = this.requireManager(type);
    try {
      const variables = manager.get_variables(name);
      return { success: true, data: variables };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Restore a resource to a historical version.
   */
  restore<T extends ResourceType>(
    type: T,
    name: string,
    targetVersion: string
  ): ServerResponse<ResourceRegistrationRecord<T>> {
    const manager = this.requireManager(type);
    const restored = manager.restore(name, targetVersion);
    if (!restored) {
      return { success: false, error: `Version '${targetVersion}' not found for '${type}:${name}'` };
    }
    return { success: true, data: restored };
  }

  /**
   * Get the version lineage for a resource.
   */
  getLineage(type: ResourceType, name: string): VersionSnapshot[] {
    const manager = this.managers.get(type);
    return manager ? manager.getVersionManager().getLineage(type, name) : [];
  }

  /**
   * Compute diff between two versions.
   */
  diff(
    type: ResourceType,
    name: string,
    fromVersion: string,
    toVersion: string
  ): ResourceDiff | null {
    const manager = this.managers.get(type);
    return manager?.getVersionManager().diff(type, name, fromVersion, toVersion) ?? null;
  }

  /**
   * Run a resource with structured input.
   */
  async run(
    type: ResourceType,
    name: string,
    input: unknown
  ): Promise<ServerResponse> {
    const manager = this.requireManager(type);
    try {
      const result = await manager.run(name, input);
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  private requireManager(type: ResourceType): ContextManager {
    const manager = this.managers.get(type);
    if (!manager) {
      throw new Error(`No ContextManager registered for resource type '${type}'`);
    }
    return manager;
  }
}

/**
 * Global ServerInterface singleton.
 */
let globalServerInterface: ServerInterface | null = null;

export function getServerInterface(): ServerInterface {
  if (!globalServerInterface) {
    globalServerInterface = new ServerInterface();
  }
  return globalServerInterface;
}

export function resetServerInterface(): void {
  globalServerInterface = null;
}
