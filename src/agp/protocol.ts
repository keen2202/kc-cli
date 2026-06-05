/**
 * Autogenesis Protocol (AGP) - Resource Substrate Protocol Layer (RSPL)
 *
 * Core type definitions implementing the formal resource model from the
 * Autogenesis paper (arXiv:2604.15034).
 *
 * Resource types: Prompt, Agent, Tool, Env, Mem
 * Each resource has: name, description, I/O mapping, evolvability marker, metadata
 * Registration record: entity + version + implementation descriptor + params + exports
 */

// ─── Resource Type Enumeration ───────────────────────────────────────────────

/**
 * RSPL entity types (τ ∈ T)
 * Corresponds to the paper's T = {Prompt, Agent, Tool, Env, Mem}
 */
export type ResourceType = 'Prompt' | 'Agent' | 'Tool' | 'Env' | 'Mem';

/** All valid resource types as an array for iteration */
export const RESOURCE_TYPES: readonly ResourceType[] = [
  'Prompt', 'Agent', 'Tool', 'Env', 'Mem',
] as const;

// ─── Input/Output Mapping ────────────────────────────────────────────────────

/**
 * Describes the input-to-output mapping φ_τ,i : X_τ → Y_τ of a resource.
 */
export interface IOMapping {
  /** Input schema or description */
  inputSchema?: Record<string, unknown> | string;
  /** Output schema or description */
  outputSchema?: Record<string, unknown> | string;
  /** Callable function implementing the mapping (optional, runtime only) */
  callable?: (input: unknown) => Promise<unknown>;
}

// ─── Exported Representations ────────────────────────────────────────────────

/**
 * Exported representation used by LLMs to interact with the resource.
 * E.g., function-calling schema, plain text description, structured argument schema.
 */
export interface ExportedRepresentation {
  /** Format type */
  format: 'function-calling' | 'text' | 'json-schema' | 'custom';
  /** The representation content */
  content: unknown;
  /** Optional label for identification */
  label?: string;
}

// ─── Resource Entity (Def. 3.1) ──────────────────────────────────────────────

/**
 * Resource Entity e_τ,i = (n_τ,i, d_τ,i, φ_τ,i, g_τ,i, m_τ,i)
 *
 * The core abstraction for any evolvable component in the system.
 *
 * @typeParam T - The resource type (Prompt | Agent | Tool | Env | Mem)
 */
export interface ResourceEntity<T extends ResourceType = ResourceType> {
  /** n_τ,i — Unique resource name (within its type namespace) */
  name: string;

  /** d_τ,i — Short human-readable description */
  description: string;

  /** φ_τ,i — Input-to-output mapping */
  ioMapping: IOMapping;

  /**
   * g_τ,i — Evolvability marker (0 or 1)
   * 0 = frozen (cannot be modified by SEPL operators)
   * 1 = evolvable (exposed to the trainable subspace Θ)
   */
  evolvability: 0 | 1;

  /** m_τ,i — Auxiliary metadata dictionary */
  metadata: ResourceMetadata<T>;
}

/**
 * Type-specific metadata for each resource type.
 * Uses discriminated union based on ResourceType.
 */
export type ResourceMetadata<T extends ResourceType = ResourceType> =
  T extends 'Prompt' ? PromptMetadata :
  T extends 'Agent' ? AgentMetadata :
  T extends 'Tool' ? ToolMetadata :
  T extends 'Env' ? EnvMetadata :
  T extends 'Mem' ? MemMetadata :
  Record<string, unknown>;

export interface PromptMetadata extends Record<string, unknown> {
  /** The prompt template text (evolvable variable) */
  template?: string;
  /** Prompt role/purpose */
  role?: string;
  /** Variables that can be substituted in the template */
  templateVariables?: string[];
}

export interface AgentMetadata extends Record<string, unknown> {
  /** System prompt for the agent (evolvable) */
  systemPrompt?: string;
  /** Allowed tool whitelist */
  allowedTools?: string[];
  /** Denied tools */
  deniedTools?: string[];
  /** Default max turns */
  defaultMaxTurns?: number;
  /** Agent role/description for orchestration */
  role?: string;
}

export interface ToolMetadata extends Record<string, unknown> {
  /** Whether the tool is read-only */
  readOnly?: boolean;
  /** Whether the tool is concurrency-safe */
  concurrencySafe?: boolean;
  /** Tool priority for loading */
  priority?: string;
  /** Import path for lazy loading */
  importPath?: string;
}

export interface EnvMetadata extends Record<string, unknown> {
  /** Working directory */
  cwd?: string;
  /** Environment variables */
  envVars?: Record<string, string>;
  /** Sandbox backend type */
  sandboxBackend?: string;
}

export interface MemMetadata extends Record<string, unknown> {
  /** Memory storage backend */
  storageBackend?: string;
  /** Relevance search configuration */
  relevanceConfig?: Record<string, unknown>;
  /** Consolidation strategy */
  consolidationStrategy?: string;
}

// ─── Resource Registration Record (Def. 3.2) ────────────────────────────────

/**
 * Resource Registration Record c_τ,i = (e_τ,i, v_τ,i, η_τ,i, θ_τ,i, F_τ,i)
 *
 * Combines the resource entity with versioning, implementation details,
 * instantiation parameters, and exported representations.
 */
export interface ResourceRegistrationRecord<T extends ResourceType = ResourceType> {
  /** e_τ,i — The resource entity */
  entity: ResourceEntity<T>;

  /** v_τ,i — Version string (semver or auto-incremented) */
  version: string;

  /**
   * η_τ,i — Implementation descriptor
   * E.g., import path, class definition, source-code string
   */
  implementationDescriptor: string;

  /**
   * θ_τ,i — Instantiation parameters
   * E.g., constructor arguments, configuration options
   */
  instantiationParams: Record<string, unknown>;

  /**
   * F_τ,i — Exported representations
   * Used by LLMs to interact with the resource
   */
  exportedRepresentations: ExportedRepresentation[];
}

// ─── Version Snapshot ────────────────────────────────────────────────────────

/**
 * Immutable snapshot of a resource at a specific version.
 * Created automatically on register/update operations.
 */
export interface VersionSnapshot<T extends ResourceType = ResourceType> {
  /** The resource name */
  resourceName: string;
  /** The resource type */
  resourceType: T;
  /** Version string */
  version: string;
  /** Timestamp of snapshot creation */
  timestamp: number;
  /** The full registration record at this version */
  record: ResourceRegistrationRecord<T>;
  /** Parent version (for lineage tracking) */
  parentVersion?: string;
  /** Branch identifier */
  branch?: string;
  /** Commit message / reason for this version */
  commitMessage?: string;
}

// ─── Resource Diff ───────────────────────────────────────────────────────────

/**
 * Diff between two versions of a resource.
 */
export interface ResourceDiff {
  resourceName: string;
  fromVersion: string;
  toVersion: string;
  /** Fields that changed */
  changes: Array<{
    field: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
  /** Whether evolvability marker changed */
  evolvabilityChanged?: boolean;
}

// ─── Context Manager Operations ──────────────────────────────────────────────

/**
 * Lifecycle state of a registered resource.
 */
export type ResourceLifecycleState =
  | 'registered'    // Registered but not yet built
  | 'built'         // Instance created from config
  | 'active'        // Currently in use
  | 'deprecated'    // Marked for removal
  | 'unregistered'; // Removed from registry

/**
 * Result of a resource retrieval operation.
 */
export interface ResourceInfo<T extends ResourceType = ResourceType> {
  record: ResourceRegistrationRecord<T>;
  lifecycleState: ResourceLifecycleState;
  versionLineage: string[]; // Version history (newest first)
}

// ─── Evolution Configuration ─────────────────────────────────────────────────

/**
 * Configuration for the self-evolution system.
 */
export interface EvolutionConfig {
  /** Whether evolution is enabled (default: false) */
  enabled: boolean;
  /** Maximum evolution iterations per cycle */
  budget: number;
  /** Whitelist of resource names eligible for evolution */
  targetResources: string[];
  /** Safety invariant checks */
  safetyInvariants: SafetyInvariant[];
  /** Auto-rollback on evaluation failure */
  autoRollback: boolean;
  /** Persist evolution state across sessions */
  persistState: boolean;
  /** LLM model to use for reflection/select operations */
  reflectionModel?: string;
}

/**
 * A safety invariant that must hold after evolution.
 */
export interface SafetyInvariant {
  name: string;
  description: string;
  /** Check function: returns true if invariant holds */
  check: (state: unknown) => boolean;
}

/** Default evolution configuration */
export const DEFAULT_EVOLUTION_CONFIG: EvolutionConfig = {
  enabled: false,
  budget: 3,
  targetResources: [],
  safetyInvariants: [],
  autoRollback: true,
  persistState: true,
};
