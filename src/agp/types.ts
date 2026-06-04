/**
 * AGP auxiliary types and utility functions.
 *
 * Provides convenience helpers for working with AGP resources,
 * type guards, factory functions, and re-exports.
 */

import type {
  ResourceType,
  ResourceEntity,
  ResourceRegistrationRecord,
  ExportedRepresentation,
  IOMapping,
  EvolutionConfig,
} from './protocol';
import { DEFAULT_EVOLUTION_CONFIG } from './protocol';

// ─── Re-exports ──────────────────────────────────────────────────────────────

export * from './protocol';

// ─── Type Guards ─────────────────────────────────────────────────────────────

/**
 * Check if a value is a valid ResourceType.
 */
export function isResourceType(value: unknown): value is ResourceType {
  return typeof value === 'string' &&
    ['Prompt', 'Agent', 'Tool', 'Env', 'Mem'].includes(value);
}

/**
 * Check if a resource is evolvable (g = 1).
 */
export function isEvolvable<T extends ResourceType>(
  entity: ResourceEntity<T>
): boolean {
  return entity.evolvability === 1;
}

// ─── Factory Functions ───────────────────────────────────────────────────────

/**
 * Create a minimal ResourceEntity with sensible defaults.
 */
export function createResourceEntity<T extends ResourceType>(
  type: T,
  name: string,
  description: string,
  options: {
    evolvability?: 0 | 1;
    ioMapping?: IOMapping;
    metadata?: Record<string, unknown>;
  } = {}
): ResourceEntity<T> {
  return {
    name,
    description,
    ioMapping: options.ioMapping ?? {},
    evolvability: options.evolvability ?? 0,
    metadata: (options.metadata ?? {}) as ResourceEntity<T>['metadata'],
  };
}

/**
 * Create a minimal ResourceRegistrationRecord with version 1.0.0.
 */
export function createRegistrationRecord<T extends ResourceType>(
  entity: ResourceEntity<T>,
  options: {
    version?: string;
    implementationDescriptor?: string;
    instantiationParams?: Record<string, unknown>;
    exportedRepresentations?: ExportedRepresentation[];
  } = {}
): ResourceRegistrationRecord<T> {
  return {
    entity,
    version: options.version ?? '1.0.0',
    implementationDescriptor: options.implementationDescriptor ?? '',
    instantiationParams: options.instantiationParams ?? {},
    exportedRepresentations: options.exportedRepresentations ?? [],
  };
}

/**
 * Create an ExportedRepresentation for function-calling schema.
 */
export function createFunctionCallingRep(
  schema: Record<string, unknown>,
  label?: string
): ExportedRepresentation {
  return {
    format: 'function-calling',
    content: schema,
    label,
  };
}

/**
 * Create an ExportedRepresentation for plain text.
 */
export function createTextRep(
  text: string,
  label?: string
): ExportedRepresentation {
  return {
    format: 'text',
    content: text,
    label,
  };
}

// ─── Resource Name Utilities ─────────────────────────────────────────────────

/**
 * Create a fully-qualified resource name: "{type}:{name}"
 */
export function qualifiedResourceName(
  type: ResourceType,
  name: string
): string {
  return `${type}:${name}`;
}

/**
 * Parse a fully-qualified resource name into type and name.
 */
export function parseQualifiedName(
  qualifiedName: string
): { type: ResourceType; name: string } | null {
  const colonIdx = qualifiedName.indexOf(':');
  if (colonIdx === -1) return null;

  const type = qualifiedName.slice(0, colonIdx);
  const name = qualifiedName.slice(colonIdx + 1);

  if (!isResourceType(type)) return null;
  return { type, name };
}

// ─── Version Utilities ───────────────────────────────────────────────────────

/**
 * Increment a semver patch version string.
 * E.g., "1.0.0" → "1.0.1", "1.2.3" → "1.2.4"
 */
export function incrementPatchVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length !== 3) {
    // Fallback: append numeric suffix
    return `${version}.1`;
  }
  const patch = parseInt(parts[2] ?? '0', 10);
  return `${parts[0]}.${parts[1]}.${patch + 1}`;
}

/**
 * Compare two semver version strings.
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);

  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va !== vb) return va - vb;
  }
  return 0;
}

// ─── Evolution Config Factory ────────────────────────────────────────────────

/**
 * Create an EvolutionConfig with defaults merged with overrides.
 */
export function createEvolutionConfig(
  overrides: Partial<EvolutionConfig> = {}
): EvolutionConfig {
  const defaults: EvolutionConfig = {
    enabled: false,
    budget: 3,
    targetResources: [],
    safetyInvariants: [],
    autoRollback: true,
    persistState: true,
  };
  return { ...defaults, ...overrides };
}
