/**
 * AGP Dynamic Manager
 *
 * Handles serialization/deserialization of resource configurations for
 * persistence and transfer. Enables safe hot-swapping of resource
 * configurations at runtime without restarting the agent system.
 *
 * Corresponds to the "Dynamic manager" infrastructure service in the
 * Autogenesis paper (§E.2.4).
 */

import type { ResourceType, ResourceRegistrationRecord } from './protocol';
import type { ServerInterface } from './server-interface';
import { getServerInterface } from './server-interface';
import * as fs from 'fs';
import * as path from 'path';

/** Versioned on-disk format for serialized AGP state (T7). */
export const AGP_STATE_FORMAT = 'kc.agp_state.v1';

/**
 * Serialized state of all AGP resources.
 */
export interface AGPSerializedState {
  /** Data-contract version marker; absent in legacy files (tolerated on load) */
  format?: string;
  version: string;
  timestamp: number;
  resources: Record<ResourceType, Record<string, ResourceRegistrationRecord>>;
}

/**
 * Hot-swap result.
 */
export interface HotSwapResult {
  success: boolean;
  swappedResources: string[];
  errors: Array<{ resource: string; error: string }>;
}

/**
 * DynamicManager handles resource persistence and runtime hot-swapping.
 */
export class DynamicManager {
  private serverInterface: ServerInterface;

  constructor(serverInterface?: ServerInterface) {
    this.serverInterface = serverInterface ?? getServerInterface();
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  /**
   * Serialize all registered resources across all types to a JSON structure.
   */
  serializeAll(): AGPSerializedState {
    const resources: Record<string, Record<string, ResourceRegistrationRecord>> = {};
    const allResources = this.serverInterface.listAll();

    for (const { type, name } of allResources) {
      if (!resources[type]) resources[type] = {};
      const record = this.serverInterface.get(type, name);
      if (record.success && record.data) {
        resources[type][name] = record.data;
      }
    }

    return {
      format: AGP_STATE_FORMAT,
      version: '1.0.0',
      timestamp: Date.now(),
      resources: resources as Record<ResourceType, Record<string, ResourceRegistrationRecord>>,
    };
  }

  /**
   * Save the complete AGP state to a JSON file.
   */
  saveToFile(filePath: string): void {
    const state = this.serializeAll();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf-8');
  }

  /**
   * Load AGP state from a JSON file.
   * Registers resources that don't exist yet; does NOT overwrite existing resources.
   */
  loadFromFile(filePath: string): { loaded: number; skipped: number } {
    if (!fs.existsSync(filePath)) {
      return { loaded: 0, skipped: 0 };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(raw) as AGPSerializedState;

    let loaded = 0;
    let skipped = 0;

    for (const [type, records] of Object.entries(state.resources)) {
      for (const [name, record] of Object.entries(records)) {
        const existing = this.serverInterface.get(type as ResourceType, name);
        if (existing.success) {
          skipped++;
          continue;
        }

        const result = this.serverInterface.register(type as ResourceType, record);
        if (result.success) {
          loaded++;
        }
      }
    }

    return { loaded, skipped };
  }

  // ─── Hot-Swap ──────────────────────────────────────────────────────────────

  /**
   * Hot-swap resource configurations from a new state snapshot.
   * Only modifies resources that already exist (updates them to new versions).
   * Does NOT add new resources or remove existing ones.
   *
   * @param newState - The new configuration state
   * @returns Results of the hot-swap operation
   */
  hotSwap(newState: AGPSerializedState): HotSwapResult {
    const swappedResources: string[] = [];
    const errors: Array<{ resource: string; error: string }> = [];

    for (const [type, records] of Object.entries(newState.resources)) {
      for (const [name, newRecord] of Object.entries(records)) {
        const qualifiedName = `${type}:${name}`;

        // Check if resource exists
        const existing = this.serverInterface.get(type as ResourceType, name);
        if (!existing.success) {
          errors.push({ resource: qualifiedName, error: 'Resource not found, cannot hot-swap' });
          continue;
        }

        // Apply update
        const result = this.serverInterface.update(type as ResourceType, name, {
          entity: newRecord.entity,
          implementationDescriptor: newRecord.implementationDescriptor,
          instantiationParams: newRecord.instantiationParams,
          exportedRepresentations: newRecord.exportedRepresentations,
          commitMessage: 'Hot-swap configuration update',
        });

        if (result.success) {
          swappedResources.push(qualifiedName);
        } else {
          errors.push({ resource: qualifiedName, error: result.error ?? 'Unknown error' });
        }
      }
    }

    return {
      success: errors.length === 0,
      swappedResources,
      errors,
    };
  }

  /**
   * Hot-swap from a file path.
   */
  hotSwapFromFile(filePath: string): HotSwapResult {
    if (!fs.existsSync(filePath)) {
      return { success: false, swappedResources: [], errors: [{ resource: filePath, error: 'File not found' }] };
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    const state = JSON.parse(raw) as AGPSerializedState;
    return this.hotSwap(state);
  }

}

/**
 * Global DynamicManager singleton.
 */
let globalDynamicManager: DynamicManager | null = null;

export function getDynamicManager(): DynamicManager {
  if (!globalDynamicManager) {
    globalDynamicManager = new DynamicManager();
  }
  return globalDynamicManager;
}

export function resetDynamicManager(): void {
  globalDynamicManager = null;
}
