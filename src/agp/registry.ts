/**
 * AGP Global Registry
 *
 * The unified global registry R = ∪R_τ that provides cross-type resource
 * access, semantic retrieval, and contract generation.
 *
 * This is the top-level entry point for the AGP system, orchestrating
 * all ContextManagers, the ServerInterface, and infrastructure services.
 *
 * Corresponds to R in the Autogenesis paper (Def 3.3).
 */

import type { ResourceType, ResourceRegistrationRecord, EvolutionConfig } from './protocol';
import { DEFAULT_EVOLUTION_CONFIG } from './protocol';
import { ContextManager } from './context-manager';
import { ServerInterface, getServerInterface } from './server-interface';
import { VersionManager, getVersionManager } from './version-manager';
import { TraceManager, getTraceManager } from './trace-manager';
import { DynamicManager, getDynamicManager } from './dynamic-manager';
import { RESOURCE_TYPES } from './protocol';

// ─── AGP System Configuration ────────────────────────────────────────────────

export interface AGPConfig {
  /** Evolution configuration */
  evolution: EvolutionConfig;
  /** Directory for AGP persistence (default: .kc-cli/agp/) */
  persistDir: string;
  /** Enable trace recording */
  tracingEnabled: boolean;
}

export const DEFAULT_AGP_CONFIG: AGPConfig = {
  evolution: DEFAULT_EVOLUTION_CONFIG,
  persistDir: '.kc-cli/agp',
  tracingEnabled: true,
};

// ─── Global Registry ─────────────────────────────────────────────────────────

/**
 * GlobalRegistry is the central coordinator for the entire AGP system.
 *
 * It holds:
 * - ContextManager for each ResourceType (M_τ)
 * - ServerInterface (A_τ) — the unified external API
 * - VersionManager — cross-type version lineage
 * - TraceManager — execution tracing
 * - DynamicManager — persistence and hot-swap
 */
export class GlobalRegistry {
  /** ServerInterface encapsulating all ContextManagers */
  readonly serverInterface: ServerInterface;

  /** Infrastructure services */
  readonly versionManager: VersionManager;
  readonly traceManager: TraceManager;
  readonly dynamicManager: DynamicManager;

  /** AGP configuration */
  private config: AGPConfig;

  /** Whether the registry has been initialized */
  private initialized = false;

  constructor(config: Partial<AGPConfig> = {}) {
    this.config = { ...DEFAULT_AGP_CONFIG, ...config };

    // Use shared infrastructure singletons
    this.versionManager = getVersionManager();
    this.traceManager = getTraceManager();
    this.dynamicManager = getDynamicManager();

    // Create the server interface
    this.serverInterface = getServerInterface();
  }

  /**
   * Initialize the global registry.
   * Creates ContextManagers for all resource types and registers them.
   */
  initialize(): void {
    if (this.initialized) return;

    // Create a ContextManager for each resource type
    for (const type of RESOURCE_TYPES) {
      const manager = new ContextManager(type, {
        versionManager: this.versionManager,
      });
      this.serverInterface.registerManager(manager);
    }

    // Start trace session if enabled
    if (this.config.tracingEnabled) {
      this.traceManager.startSession(`agp-${Date.now()}`);
    }

    this.initialized = true;
  }

  /**
   * Get the AGP configuration.
   */
  getConfig(): AGPConfig {
    return { ...this.config };
  }

  /**
   * Update AGP configuration.
   */
  updateConfig(updates: Partial<AGPConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  // ─── Convenience Accessors ───────────────────────────────────────────────

  /**
   * Register a resource of any type.
   */
  register<T extends ResourceType>(
    type: T,
    record: ResourceRegistrationRecord<T>
  ): string {
    const result = this.serverInterface.register(type, record);
    if (!result.success) {
      throw new Error(result.error);
    }
    return result.version ?? record.version;
  }

  /**
   * Get a resource record.
   */
  get<T extends ResourceType>(
    type: T,
    name: string
  ): ResourceRegistrationRecord<T> | null {
    const result = this.serverInterface.get(type, name);
    return result.success ? (result.data as ResourceRegistrationRecord<T>) : null;
  }

  /**
   * List all resources across all types.
   */
  listAll(): Array<{ type: ResourceType; name: string }> {
    return this.serverInterface.listAll();
  }

  /**
   * Semantic retrieval across all resource types.
   */
  retrieve(query: string, limit = 10): ResourceRegistrationRecord[] {
    return this.serverInterface.retrieve(query, limit);
  }

  /**
   * Get the total number of registered resources.
   */
  get totalResources(): number {
    return this.serverInterface.listAll().length;
  }

  /**
   * Check if the registry is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  // ─── Persistence ─────────────────────────────────────────────────────────

  /**
   * Save the complete AGP state to disk.
   */
  saveState(): void {
    const filePath = `${this.config.persistDir}/agp-state.json`;
    this.dynamicManager.saveToFile(filePath);
  }

  /**
   * Load AGP state from disk.
   */
  loadState(): { loaded: number; skipped: number } {
    const filePath = `${this.config.persistDir}/agp-state.json`;
    return this.dynamicManager.loadFromFile(filePath);
  }

  // ─── Shutdown ────────────────────────────────────────────────────────────

  /**
   * Shutdown the AGP system. Persists state and ends trace sessions.
   */
  shutdown(): void {
    if (this.config.evolution.persistState) {
      try {
        this.saveState();
      } catch {
        // Best-effort persistence
      }
    }

    if (this.config.tracingEnabled) {
      this.traceManager.endSession();
    }

    this.initialized = false;
  }
}

// ─── Global Singleton ────────────────────────────────────────────────────────

let globalRegistry: GlobalRegistry | null = null;

/**
 * Get or create the global AGP registry.
 * Initializes on first call if not already initialized.
 */
export function getGlobalRegistry(config?: Partial<AGPConfig>): GlobalRegistry {
  if (!globalRegistry) {
    globalRegistry = new GlobalRegistry(config);
    globalRegistry.initialize();
  }
  return globalRegistry;
}

/**
 * Check if the global registry exists (without creating it).
 */
export function hasGlobalRegistry(): boolean {
  return globalRegistry !== null;
}

/**
 * Reset the global registry (for testing).
 */
export function resetGlobalRegistry(): void {
  globalRegistry?.shutdown();
  globalRegistry = null;
}
